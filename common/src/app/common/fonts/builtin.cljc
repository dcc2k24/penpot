;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.common.fonts.builtin
  "The bundled font table: the families served from `<public-uri>/fonts/`.
  Pure data, so the JVM backend and the JS hosts read the same table.")

(def local-fonts
  [{:id "sourcesanspro"
    :name "Source Sans Pro"
    :family "sourcesanspro"
    :variants
    [{:id "200" :name "200" :weight "200" :style "normal" :suffix "extralight" :ttf-url "sourcesanspro-extralight.ttf"}
     {:id "200italic" :name "200 Italic" :weight "200" :style "italic" :suffix "extralightitalic" :ttf-url "sourcesanspro-extralightitalic.ttf"}
     {:id "300" :name "300" :weight "300" :style "normal" :suffix "light" :ttf-url "sourcesanspro-light.ttf"}
     {:id "300italic" :name "300 Italic"  :weight "300" :style "italic" :suffix "lightitalic" :ttf-url "sourcesanspro-lightitalic.ttf"}
     {:id "regular" :name "400" :weight "400" :style "normal" :ttf-url "sourcesanspro-regular.ttf"}
     {:id "italic" :name "400 Italic" :weight "400" :style "italic" :ttf-url "sourcesanspro-italic.ttf"}
     {:id "600" :name "600" :weight "600" :style "normal" :suffix "semibold" :ttf-url "sourcesanspro-semibold.ttf"}
     {:id "600italic" :name "600 Italic" :weight "600" :style "italic" :suffix "semibolditalic" :ttf-url "sourcesanspro-semibolditalic.ttf"}
     {:id "bold" :name "700" :weight "700" :style "normal" :ttf-url "sourcesanspro-bold.ttf"}
     {:id "bolditalic" :name "700 Italic" :weight "700" :style "italic" :ttf-url "sourcesanspro-bolditalic.ttf"}
     {:id "black" :name "900" :weight "900" :style "normal" :ttf-url "sourcesanspro-black.ttf"}
     {:id "blackitalic" :name "900 Italic" :weight "900" :style "italic" :ttf-url "sourcesanspro-blackitalic.ttf"}]}])
