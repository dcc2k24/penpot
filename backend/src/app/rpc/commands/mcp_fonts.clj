;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.mcp-fonts
  "Read command of the backend-native MCP that lists the fonts a file uses
  and says whether each one resolves: `get-mcp-fonts`. See
  `mcp/docs/backend-mode-contract.md`."
  (:require
   [app.common.schema :as sm]
   [app.rpc :as-alias rpc]
   [app.rpc.climit :as-alias climit]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.doc :as-alias doc]
   [app.rpc.mcp-fonts :as mcp-fonts]
   [app.util.services :as sv]))

(def ^:private max-fonts
  "Most fonts one reply holds. A file with more reports `truncated`."
  500)

(def ^:private schema:get-fonts
  [:and
   [:map {:title "get-mcp-fonts" :closed true}
    [:file-id ::sm/uuid]
    [:page-id {:optional true} ::sm/uuid]
    [:root-ids {:optional true} [:vector {:min 1 :max 200} ::sm/uuid]]]
   [:fn {:error/message "root-ids needs page-id"}
    (fn [{:keys [root-ids page-id]}]
      (or (nil? root-ids) (some? page-id)))]])

(sv/defmethod ::get-mcp-fonts
  "Fonts the text of a file uses. Each font says where it comes from
  (`source`), whether it resolves and why not, its runs and shapes, the pages
  it is on, and its variants with their download `url` when they have one.
  A font that does not resolve carries `suggested-font-id` and the other
  `suggested-*` keys when a font that resolves has the same family.
  Without `page-id` every page is read, within five seconds; past that,
  `truncated`. A reply that is not `truncated` is the complete font report of
  the file. `pages-read` and `pages-total` count the pages read and asked for. `root-ids` (which needs `page-id`) limits the report to the
  subtrees of those shapes. A reply holds at most 500 fonts and stays within
  the response byte budget."
  {::rpc/token-type "mcp"
   ::rpc/mcp-scope "mcp:read"
   ::climit/id [[:mcp-read/by-profile ::rpc/profile-id] [:mcp-read/global]
                [:mcp-find/by-file :file-id]]
   ::doc/added "2.20"
   ::doc/module :mcp
   ::sm/params schema:get-fonts}
  [cfg {:keys [::rpc/profile-id file-id page-id root-ids] :as params}]
  (mcp/run-tool cfg "get-mcp-fonts" params
                (fn []
                  (mcp/check-access! cfg params profile-id file-id)
                  (let [file     (mcp/load-file-for-page cfg file-id page-id [])
                        data     (:data file)
                        revn     (:revn file)
                        vern     (:vern file)
                        ctx      (mcp-fonts/get-font-context cfg (:team-id file))
                        page-ids (if (some? page-id) [page-id] (vec (:pages data)))
                        pages    (mapv (fn [id]
                                         {:id id
                                          :key (mcp-fonts/get-page-key file-id vern revn data id)})
                                       page-ids)
                        scan     (mcp-fonts/get-pages-usage
                                  {:pages pages
                                   :load-objects (fn [id]
                                                   (:objects (mcp/get-page-data cfg file-id revn data id)))
                                   :root-ids root-ids
                                   :budget-ns (when (nil? page-id)
                                                mcp-fonts/scan-budget-ns)})
                        fonts    (mcp-fonts/get-fonts-report ctx (:page-usages scan))
                        [kept
                         byte-cut?] (mcp/within-budget identity
                                                       (take max-fonts fonts)
                                                       mcp/response-byte-budget)]
                    [{:revn revn
                      :fonts kept
                      :unresolved (count (remove :resolved fonts))
                      :pages-read (count (:page-usages scan))
                      :pages-total (count pages)
                      :truncated (or (not (:complete scan))
                                     (> (count fonts) max-fonts)
                                     byte-cut?)}
                     {:file-id file-id
                      :page-ids (mapv first (:page-usages scan))
                      :revn revn
                      :token-id (mcp/get-token-id params)}]))))
