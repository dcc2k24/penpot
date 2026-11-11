;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.mcp-font-lookup
  "The font data that the `replace_font` operation reads: for a font id, the
  family string the workspace writes into a text and the variants of the font,
  each as `{:id :weight :style}`.

  It is built on the resolution of the font report (`app.rpc.mcp-fonts`): the
  source of the font, its listing and the reason it does not resolve. A
  bundled font gives its table (`app.common.fonts.builtin`), a Google font
  its catalogue entry, a team font its rows in `team_font_variant`. The ids of
  the variants are the ones the workspace writes: the bundled table ids, the
  Google ids (`regular`, `italic`, `700`, `700italic`) and, for a team font,
  `<style>-<weight>`.

  A font that does not resolve gives `{:reason code}`, with the codes of the
  font report (`google-fonts-disabled`, `not-in-google-catalog`,
  `custom-font-not-in-team`, `unknown-font-id`)."
  (:require
   [app.config :as cf]
   [app.rpc.mcp-fonts :as mcp-fonts]))

(defn resolve-font
  "The font `font-id` as `{:family :variants}`, or `{:reason code}`. `ctx` is
  a font context (`app.rpc.mcp-fonts/get-font-context`). A Google font while
  the provider is off is refused before the catalogue is read."
  [ctx font-id]
  (let [source  (mcp-fonts/get-font-source font-id)
        listing (when-not (and (= :google source) (not (:google-on ctx)))
                  (mcp-fonts/get-font-listing ctx font-id source))]
    (if-let [reason (mcp-fonts/get-font-reason ctx source listing)]
      {:reason reason}
      {:family (mcp-fonts/get-write-family font-id source listing)
       :variants (mapv #(select-keys % [:id :weight :style]) (:variants listing))})))

(defn make-font-lookup
  "The lookup function for the compile of one call: font id to the result of
  `resolve-font`. The team font rows are read on the first team font asked
  for, with one query, and not at all for another font."
  [cfg team-id]
  (let [light (delay {:google-on (contains? cf/flags :google-fonts-provider)})
        full  (delay (mcp-fonts/get-font-context cfg team-id))]
    (fn [font-id]
      (resolve-font (if (= :custom (mcp-fonts/get-font-source font-id))
                      @full
                      @light)
                    font-id))))
