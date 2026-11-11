;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.fonts-missing
  "Finds the text fonts that are not installed. Pure logic: no store,
  no atoms, no DOM. The installed check is passed in by the caller."
  (:require
   [app.common.types.text :as txt]
   [cuerdas.core :as str]))

(defn- visit-shapes
  "Returns the shapes for `ids` and all their descendants, each once.
  Ids that are not in `objects` are skipped."
  [objects ids]
  (loop [stack   (vec ids)
         visited #{}
         result  []]
    (if (empty? stack)
      result
      (let [id    (peek stack)
            stack (pop stack)]
        (if (or (contains? visited id)
                (not (contains? objects id)))
          (recur stack visited result)
          (let [shape (get objects id)]
            (recur (into stack (:shapes shape))
                   (conj visited id)
                   (conj result shape))))))))

(defn- missing-leaves
  "Returns the text leaves of `shape` that have a font id which is
  not installed. Leaves without a font id use the default font and are
  never reported."
  [installed? shape]
  (when (some? (:content shape))
    (->> (txt/node-seq txt/is-text-node? (:content shape))
         (filter #(some? (:font-id %)))
         (remove #(installed? (:font-id %))))))

(defn shape-missing-fonts
  "Returns a vector of {:font-id :font-family} for the fonts of the text
  `shape` that are not installed, one entry per font id, sorted by family
  then font id. Only the content of `shape` itself is read. A shape that
  is not a text yields [] and `installed?` is never called. Leaves without
  a font id use the default font and are never reported."
  [shape installed?]
  (if (= :text (:type shape))
    (->> (missing-leaves installed? shape)
         (reduce (fn [acc {:keys [font-id font-family]}]
                   (if (contains? acc font-id)
                     acc
                     (assoc acc font-id {:font-id     font-id
                                         :font-family (or font-family font-id)})))
                 {})
         (vals)
         (sort-by (juxt :font-family :font-id) compare)
         (vec))
    []))

(defn objects-with-exports
  "Returns `objects` with the shapes carried by `exports` added for the
  ids that `objects` does not hold. Page objects win over a carried shape
  with the same id. `objects` may be nil. Each export carries its
  `:object-id` and its `:shape` (the shape without `:exports`); an export
  without a shape adds nothing."
  [objects exports]
  (reduce (fn [acc {:keys [object-id shape]}]
            (if (and (some? shape)
                     (not (contains? acc object-id)))
              (assoc acc object-id shape)
              acc))
          (or objects {})
          exports))

(defn get-missing-fonts
  "Returns a vector of {:font-id :font-family :shapes} for the fonts
  used by the shapes in `ids` (and their children) that are not
  installed. `:shapes` counts the distinct shapes using the font.
  The result is sorted by family, then font id. `objects` is a map of
  id to shape and may be nil."
  [objects ids installed?]
  (let [entries (into []
                      (mapcat (fn [shape]
                                (for [leaf (missing-leaves installed? shape)]
                                  [(:font-id leaf)
                                   (:font-family leaf)
                                   (:id shape)])))
                      (visit-shapes objects ids))
        groups  (reduce (fn [acc [font-id family shape-id]]
                          (update acc font-id
                                  (fn [entry]
                                    (-> (or entry {:font-id     font-id
                                                   :font-family (or family font-id)
                                                   :shape-ids   #{}})
                                        (update :shape-ids conj shape-id)))))
                        {}
                        entries)]
    (->> (vals groups)
         (map (fn [{:keys [font-id font-family shape-ids]}]
                {:font-id     font-id
                 :font-family font-family
                 :shapes      (count shape-ids)}))
         (sort-by (juxt :font-family :font-id) compare)
         (vec))))

(defn families-label
  "Comma-separated, distinct family names of the missing fonts, in result order."
  [missing]
  (str/join ", " (distinct (map :font-family missing))))
