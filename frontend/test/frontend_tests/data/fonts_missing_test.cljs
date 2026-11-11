;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.fonts-missing-test
  (:require
   [app.common.uuid :as uuid]
   [app.main.data.fonts-missing :as fonts-missing]
   [cljs.test :as t :include-macros true]))

(defn- installed?
  [font-id]
  (contains? #{"sourcesanspro"} font-id))

(defn- leaf
  [text font-id family]
  {:text text :font-id font-id :font-family family})

(defn- text-shape
  [id leaves]
  {:id id
   :type :text
   :content {:type "root"
             :children [{:type "paragraph-set"
                         :children [{:type "paragraph"
                                     :children leaves}]}]}})

(defn- objects-of
  [shapes]
  (into {} (map (juxt :id identity)) shapes))

(t/deftest missing-fonts-empty-input
  (t/is (= [] (fonts-missing/get-missing-fonts nil [] installed?)))
  (t/is (= [] (fonts-missing/get-missing-fonts {} [] installed?)))
  (t/is (= [] (fonts-missing/get-missing-fonts nil [(uuid/next)] installed?))))

(t/deftest installed-font-is-not-reported
  (let [id (uuid/next)
        objects (objects-of [(text-shape id [(leaf "Hi" "sourcesanspro" "Source Sans Pro")])])]
    (t/is (= [] (fonts-missing/get-missing-fonts objects [id] installed?)))))

(t/deftest missing-font-is-reported
  (let [id (uuid/next)
        objects (objects-of [(text-shape id [(leaf "Hi" "gfont-access-sans" "Access Sans")])])]
    (t/is (= [{:font-id "gfont-access-sans" :font-family "Access Sans" :shapes 1}]
             (fonts-missing/get-missing-fonts objects [id] installed?)))))

(t/deftest same-missing-font-in-two-shapes-counts-two
  (let [id-a (uuid/next)
        id-b (uuid/next)
        objects (objects-of [(text-shape id-a [(leaf "A" "gfont-access-sans" "Access Sans")])
                             (text-shape id-b [(leaf "B" "gfont-access-sans" "Access Sans")])])]
    (t/is (= [{:font-id "gfont-access-sans" :font-family "Access Sans" :shapes 2}]
             (fonts-missing/get-missing-fonts objects [id-a id-b] installed?)))))

(t/deftest text-inside-selected-board-is-found
  (let [board-id (uuid/next)
        child-id (uuid/next)
        child    (assoc (text-shape child-id [(leaf "Hi" "gfont-access-sans" "Access Sans")])
                        :parent-id board-id)
        board    {:id board-id :type :frame :shapes [child-id]}
        objects  (objects-of [board child])]
    (t/is (= [{:font-id "gfont-access-sans" :font-family "Access Sans" :shapes 1}]
             (fonts-missing/get-missing-fonts objects [board-id] installed?)))))

(t/deftest leaf-without-font-id-is-never-reported
  (let [id (uuid/next)
        objects (objects-of [(text-shape id [{:text "Hi" :font-family "Fallback"}])])]
    (t/is (= [] (fonts-missing/get-missing-fonts objects [id] installed?)))))

(t/deftest mixed-runs-report-only-the-missing-font
  (let [id (uuid/next)
        objects (objects-of [(text-shape id [(leaf "Hi" "sourcesanspro" "Source Sans Pro")
                                             (leaf " there" "gfont-x" "Gamma X")])])]
    (t/is (= [{:font-id "gfont-x" :font-family "Gamma X" :shapes 1}]
             (fonts-missing/get-missing-fonts objects [id] installed?)))))

(t/deftest result-is-sorted-by-family
  (let [id-a (uuid/next)
        id-b (uuid/next)
        objects (objects-of [(text-shape id-a [(leaf "Z" "gfont-zeta" "Zeta")])
                             (text-shape id-b [(leaf "A" "gfont-alpha" "Alpha")])])
        result  (fonts-missing/get-missing-fonts objects [id-a id-b] installed?)]
    (t/is (= ["Alpha" "Zeta"] (mapv :font-family result)))))

(t/deftest export-shape-is-checked-without-page-objects
  (let [id      (uuid/next)
        exports [{:object-id id
                  :shape (text-shape id [(leaf "Hi" "gfont-access-sans" "Access Sans")])}]
        objects (fonts-missing/objects-with-exports nil exports)]
    (t/is (= [{:font-id "gfont-access-sans" :font-family "Access Sans" :shapes 1}]
             (fonts-missing/get-missing-fonts objects [id] installed?)))))

(t/deftest page-objects-win-over-the-carried-shape
  (let [id      (uuid/next)
        page    (objects-of [(text-shape id [(leaf "Hi" "sourcesanspro" "Source Sans Pro")])])
        exports [{:object-id id
                  :shape (text-shape id [(leaf "Hi" "gfont-access-sans" "Access Sans")])}]
        objects (fonts-missing/objects-with-exports page exports)]
    (t/is (= [] (fonts-missing/get-missing-fonts objects [id] installed?)))))

(t/deftest export-id-in-neither-is-skipped
  (let [id      (uuid/next)
        exports [{:object-id id}]
        objects (fonts-missing/objects-with-exports nil exports)]
    (t/is (= {} objects))
    (t/is (= [] (fonts-missing/get-missing-fonts objects [id] installed?)))))

(t/deftest families-label-joins-distinct-families
  (t/is (= "Alpha, Zeta"
           (fonts-missing/families-label [{:font-family "Alpha"}
                                          {:font-family "Zeta"}]))))

(t/deftest shape-missing-fonts-reports-a-missing-font
  (let [shape (text-shape (uuid/next) [(leaf "Hi" "gfont-access-sans" "Access Sans")])]
    (t/is (= [{:font-id "gfont-access-sans" :font-family "Access Sans"}]
             (fonts-missing/shape-missing-fonts shape installed?)))))

(t/deftest shape-missing-fonts-ignores-installed-fonts
  (let [shape (text-shape (uuid/next) [(leaf "Hi" "sourcesanspro" "Source Sans Pro")])]
    (t/is (= [] (fonts-missing/shape-missing-fonts shape installed?)))))

(t/deftest shape-missing-fonts-reports-a-mixed-family-once
  (let [shape (text-shape (uuid/next)
                          [(leaf "Hi" "sourcesanspro" "Source Sans Pro")
                           (leaf " a" "gfont-x" "Gamma X")
                           (leaf " b" "gfont-x" "Gamma X")
                           (leaf " c" "gfont-alpha" "Alpha")])]
    (t/is (= [{:font-id "gfont-alpha" :font-family "Alpha"}
              {:font-id "gfont-x" :font-family "Gamma X"}]
             (fonts-missing/shape-missing-fonts shape installed?)))))

(t/deftest shape-missing-fonts-leaves-without-font-id-use-the-default
  (let [shape (text-shape (uuid/next) [{:text "Hi" :font-family "Fallback"}])]
    (t/is (= [] (fonts-missing/shape-missing-fonts shape installed?)))))

(t/deftest shape-missing-fonts-skips-non-text-shapes
  (let [calls (atom 0)
        count-installed? (fn [_] (swap! calls inc) false)
        board {:id (uuid/next) :type :frame :shapes []}
        ;; A non-text shape never carries content, but even if it did the
        ;; check must not run.
        odd   (assoc board :content (:content (text-shape (uuid/next) [(leaf "Hi" "gfont-x" "X")])))]
    (t/is (= [] (fonts-missing/shape-missing-fonts board count-installed?)))
    (t/is (= [] (fonts-missing/shape-missing-fonts odd count-installed?)))
    (t/is (= [] (fonts-missing/shape-missing-fonts nil count-installed?)))
    (t/is (zero? @calls))))
