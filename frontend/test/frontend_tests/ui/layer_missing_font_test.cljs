;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.ui.layer-missing-font-test
  "The warning badge on a text layer row whose font is not installed.
  The row component needs the whole store, so these tests render the
  badge component alone, as the row does for a text shape. The badge reads
  `refs/team-fonts-fetched?`, a derived ref built on the original store. Other
  tests replace `st/state` and do not put it back, so these tests bind that
  ref to a plain atom for each render and leave the store alone."
  (:require
   ["react-dom/server" :as rds]
   [app.main.refs :as refs]
   [app.main.ui.workspace.sidebar.layer-item :as li]
   [app.util.i18n :as i18n]
   [cljs.test :as t :include-macros true]
   [cuerdas.core :as str]
   [okulary.core :as l]
   [rumext.v2 :as mf]))

(defn- content
  [font-id family]
  {:type "root"
   :children [{:type "paragraph-set"
               :children [{:type "paragraph"
                           :children [{:text "Hi"
                                       :font-id font-id
                                       :font-family family}]}]}]})

(defn- render-badge
  "Static markup of the badge. `fetched?` is the value of
  `refs/team-fonts-fetched?` for the render: whether the team fonts are in
  the state, as `fonts-fetched` leaves them. The store is not touched."
  [fetched? content]
  (with-redefs [refs/team-fonts-fetched? (l/atom fetched?)
                i18n/tr (fn [k & args] (str k ":" (apply str args)))]
    (rds/renderToStaticMarkup
     (mf/element li/missing-font-badge* #js {:content content}))))

(t/deftest badge-is-absent-until-the-team-fonts-are-fetched
  (t/is (= "" (render-badge false (content "custom-team-font" "Team Font"))))
  (t/is (= "" (render-badge false (content "gfont-access-sans" "Access Sans")))))

(t/deftest badge-shows-for-a-missing-font-once-fetched
  (let [markup (render-badge true (content "gfont-access-sans" "Access Sans"))]
    (t/is (str/includes? markup "title=\"workspace.sidebar.layers.font-missing:Access Sans\""))
    (t/is (str/includes? markup "aria-label=\"workspace.sidebar.layers.font-missing:Access Sans\""))
    (t/is (str/includes? markup "role=\"img\""))))

(t/deftest badge-is-absent-for-an-installed-font-once-fetched
  (t/is (= "" (render-badge true (content "sourcesanspro" "Source Sans Pro")))))

(t/deftest badge-is-absent-for-a-text-without-font-id
  (t/is (= "" (render-badge true {:type "root"
                                  :children [{:type "paragraph-set"
                                              :children [{:type "paragraph"
                                                          :children [{:text "Hi"}]}]}]}))))
