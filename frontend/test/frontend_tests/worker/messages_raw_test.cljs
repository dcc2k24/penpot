;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.worker.messages-raw-test
  (:require
   [app.common.types.objects-map :as omap]
   [app.common.uuid :as uuid]
   [app.worker.messages :as wm]
   [cljs.test :as t :include-macros true]))

(def ^:private id-a (uuid/custom 1))
(def ^:private id-b (uuid/custom 2))
(def ^:private id-c (uuid/custom 3))
(def ^:private id-d (uuid/custom 4))

(defn- make-shape
  [id x]
  {:id id
   :name (str "Shape " x)
   :type :rect
   :x x
   :y 0
   :width 10
   :height 20
   :parent-id uuid/zero
   :frame-id uuid/zero})

(t/deftest raw-payload-survives-encode-decode
  (let [objects (omap/wrap {id-a (make-shape id-a 1)
                            id-b (make-shape id-b 2)})
        raw     (omap/raw-entries objects)
        page    {:id (uuid/custom 10) :name "Page"}
        msg     {:sender-id (uuid/next)
                 :payload {:cmd :index/initialize
                           :page page
                           :raw raw}}
        decoded (wm/decode (wm/encode msg))]
    (t/is (identical? raw (get-in decoded [:payload :raw])))
    (t/is (= :index/initialize (get-in decoded [:payload :cmd])))
    (t/is (= page (get-in decoded [:payload :page])))
    (t/is (= (:sender-id msg) (:sender-id decoded)))))

(t/deftest from-raw-entries-restores-objects
  (let [objects  (omap/wrap {id-a (make-shape id-a 1)
                             id-b (make-shape id-b 2)
                             id-c (make-shape id-c 3)})

        ;; The assoc leaves a nil raw value for `id-d`.
        objects  (assoc objects id-d (make-shape id-d 4))
        restored (omap/from-raw-entries (omap/raw-entries objects))]
    (t/is (omap/objects-map? restored))
    (t/is (= (count objects) (count restored)))
    (t/is (= (into #{} (keys objects)) (into #{} (keys restored))))
    (doseq [id (keys objects)]
      (t/is (= (get objects id) (get restored id))))))
