;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.mcp-disabled-route-test
  "An MCP token of a profile that turned MCP off is refused on the real
  RPC route, through the token lookup that sets the switch."
  (:require
   [app.common.json :as json]
   [app.db :as db]
   [app.http :as http]
   [app.rpc.commands.access-token :as access-token]
   [app.rpc.commands.profile :as profile]
   [backend-tests.helpers :as th]
   [clojure.test :as t]
   [ring.core.protocols :as rcp]
   [yetti.response :as yres]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware])
                       th/init-system))
(t/use-fixtures :each th/database-reset)

(defn- call
  "Posts the command `path` with the bearer MCP token `token`."
  [path token]
  ((#'http/router-handler (::http/router th/*system*))
   (th/make-dummy-request
    {:path path
     :method :post
     :headers {"content-type" "application/json"
               "accept" "application/json"
               "x-client" "penpot-mcp"
               "authorization" (str "Token " token)}
     :body-bytes (json/encode {})})))

(defn- reply-code
  [reply]
  (let [out (java.io.ByteArrayOutputStream.)]
    (rcp/write-body-to-stream (::yres/body reply) nil out)
    (get (json/decode (str out)) "code")))

(t/deftest mcp-token-is-refused-once-the-profile-turns-mcp-off
  (let [profile (th/create-profile* 1 {:is-active true})
        token   (:token (db/tx-run! th/*system* access-token/create-access-token
                                    (:id profile) "MCP" nil "mcp"))
        path    "/api/main/methods/get-projects"]
    (t/is (string? token))
    (t/testing "with MCP on the token gets past the switch"
      (t/is (not= 403 (::yres/status (call path token)))))
    (db/tx-run! th/*system* profile/update-profile-props (:id profile) {:mcp-enabled false})
    (t/testing "with MCP off the same token is refused"
      (let [reply (call path token)]
        ;; A restriction is answered 400, as the other restriction errors are.
        (t/is (= 400 (::yres/status reply)))
        (t/is (= "mcp-disabled" (reply-code reply)))))))
