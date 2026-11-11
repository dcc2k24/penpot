;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.common.fonts.variants
  "Font variant choice, shared by the JVM and the JS hosts. The workspace picks
  the variant of a font for a weight and a style by `app.common.fonts/closest-variant`
  (ClojureScript only); this namespace holds the same rule in `.cljc`, so the
  backend picks as the workspace does."
  (:require
   [app.common.data :as d]))

(defn closest-variant
  "The variant of `variants` closest to `target-weight`, or nil when the weight
  is not a number or no variant has a numeric weight. `variants` are maps with
  string `:weight` and `:style`. An exact weight match wins, and with a
  `target-style` it must match the style too. When two weights are equally
  near, the higher one wins. At the same weight, a variant with the style of
  `target-style` wins over one without.

  This is the rule of `app.common.fonts/closest-variant`, which the workspace
  and the exporter use. The one difference: a variant whose weight is not a
  number is passed over, where the ClojureScript version would fail on it."
  [variants target-weight target-style]
  (when-let [target-weight (d/parse-integer target-weight)]
    (let [result
          (reduce
           (fn [closest-match variant]
             (if-let [weight (d/parse-integer (:weight variant))]
               (let [distance       (abs (- target-weight weight))
                     matches-style? (= target-style (:style variant))
                     current        {:variant variant
                                     :weight weight
                                     :distance distance}]
                 (cond
                   ;; Exact match found
                   (and (zero? distance)
                        (if target-style matches-style? true))
                   (reduced current)

                   (nil? closest-match) current

                   ;; Closer, or as near but heavier
                   (or (< distance (:distance closest-match))
                       (and (= distance (:distance closest-match))
                            (> weight (:weight closest-match))))
                   current

                   ;; Same weight as the best match, and the style matches
                   (and (= weight (:weight closest-match)) matches-style?)
                   current

                   :else
                   closest-match))
               closest-match))
           nil
           variants)]
      (:variant result))))
