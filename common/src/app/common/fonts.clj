;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.common.fonts
  "A fonts loading macros."

  (:require
   [app.common.uuid :as uuid]
   [clojure.data.json :as json]
   [clojure.java.io :as io]
   [cuerdas.core :as str]))

(defn- parse-gfont-variant
  [variant files]
  (cond
    (= "regular" variant)
    {:id "regular" :name "400" :weight "400" :style "normal" :ttf-url (get files "regular")}

    (= "italic" variant)
    {:id "italic" :name "400 Italic" :weight "400" :style "italic" :ttf-url (get files "italic")}

    :else
    (when-let [[id weight style] (re-find #"^(\d+)(.*)$" variant)]
      {:id id
       :name (str/trim (str weight " " (str/capital style)))
       :weight weight
       :style (if (str/empty? style) "normal" style)
       :ttf-url (get files id)})))

(defn- parse-gfont
  [font]
  (let [family (get font "family")
        variants (get font "variants")
        files (get font "files")]
    {:id (str "gfont-" (str/slug family))
     :uuid (uuid/random)
     :family family
     :name family
     :variants (into [] (comp (map (fn [variant] (parse-gfont-variant variant files)))
                              (filter identity))
                     variants)}))

(def gfonts-resource
  "The Google catalogue: the JSON resource on the classpath that
  `load-gfonts` and the CLJS macro `preload-gfonts` read."
  "fonts/gfonts.2025.11.28.json")

(defn load-gfonts
  "The Google catalogue read from the JSON resource at `path` (a classpath
  path): a vector of fonts, each with `:id` (`gfont-<slug>`), `:uuid`,
  `:family`, `:name` and `:variants` (`:id`, `:name`, `:weight`, `:style`,
  `:ttf-url`). The one parser for the CLJS macro and for the JVM backend."
  [path]
  (let [data (json/read-str (slurp (io/resource path)))]
    (mapv parse-gfont (get data "items"))))

(defmacro preload-gfonts
  "The Google catalogue at `path`, embedded as a literal at compile time."
  [path]
  `~(load-gfonts path))
