;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.util-webapi-test
  (:require
   [app.util.globals :as globals]
   [app.util.webapi :as wapi]
   [cljs.test :as t :include-macros true]))

(t/deftest data-uri->blob-supports-base64
  (t/async done
    (let [blob (wapi/data-uri->blob "data:text/plain;base64,SGVsbG8=")]
      (-> (.text blob)
          (.then (fn [text]
                   (t/is (= "text/plain" (.-type blob)))
                   (t/is (= "Hello" text))
                   (done)))
          (.catch (fn [err]
                    (t/is false (str "unexpected error: " err))
                    (done)))))))

(t/deftest data-uri->blob-supports-utf8-data
  (t/async done
    (let [blob (wapi/data-uri->blob "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E")]
      (-> (.text blob)
          (.then (fn [text]
                   (t/is (= "image/svg+xml" (.-type blob)))
                   (t/is (= "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" text))
                   (done)))
          (.catch (fn [err]
                    (t/is false (str "unexpected error: " err))
                    (done)))))))

(t/deftest on-dpr-change-cancel-removes-listener
  (let [win      globals/window
        orig-mm  (.-matchMedia ^js win)
        orig-dpr (.-devicePixelRatio ^js win)
        queries  (atom [])
        added    (atom [])
        removed  (atom [])
        active   (atom [])
        seen     (atom [])
        drop!    (fn [handler]
                   (swap! active
                          (fn [entries]
                            (vec (remove #(identical? handler (:handler %)) entries)))))
        fire!    (fn [handler]
                   ;; mimic { :once true }: a listener is gone once it has fired
                   (drop! handler)
                   (handler #js {}))
        make-mq  (fn [query]
                   #js {:media query
                        :addEventListener
                        (fn [type handler _opts]
                          (let [entry {:query query :type type :handler handler}]
                            (swap! added conj entry)
                            (swap! active conj entry)))
                        :removeEventListener
                        (fn [type handler]
                          (swap! removed conj {:type type :handler handler})
                          (drop! handler))})]
    (try
      (set! (.-devicePixelRatio ^js win) 2)
      (set! (.-matchMedia ^js win)
            (fn [query]
              (swap! queries conj query)
              (make-mq query)))
      (let [cancel! (wapi/on-dpr-change #(swap! seen conj %))]
        ;; 1. exactly one listener, on the query for DPR 2
        (t/is (= ["(resolution: 2dppx)"] @queries))
        (t/is (= 1 (count @added)))
        (t/is (= "change" (:type (first @added))))
        (t/is (= 1 (count @active)))

        ;; 2. firing it calls f with the current DPR and listens on a new query
        (let [first-handler (:handler (first @active))]
          (set! (.-devicePixelRatio ^js win) 3)
          (fire! first-handler)
          (t/is (= [3] @seen))
          (t/is (= ["(resolution: 2dppx)" "(resolution: 3dppx)"] @queries))
          (t/is (= 1 (count @active)))

          ;; 3. cancel removes the listener that is registered now
          (let [live-handler (:handler (first @active))]
            (cancel!)
            (t/is (empty? @active))
            (t/is (= 1 (count @removed)))
            (t/is (identical? live-handler (:handler (first @removed))))

            ;; 4. a second cancel changes nothing; the old handler does not call f
            (cancel!)
            (t/is (= 1 (count @removed)))
            (live-handler #js {})
            (t/is (= [3] @seen))
            (t/is (= 2 (count @queries)))
            (t/is (empty? @active)))))
      (finally
        (set! (.-matchMedia ^js win) orig-mm)
        (set! (.-devicePixelRatio ^js win) orig-dpr)))))
