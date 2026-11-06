;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-scope-test
  (:require
   [app.common.json :as json]
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.http :as http]
   [app.rpc :as rpc]
   [app.rpc.commands.access-token :as access-token]
   [app.rpc.mcp-scope :as mcp-scope]
   [backend-tests.helpers :as th]
   [clojure.test :as t]
   [ring.core.protocols :as rcp]
   [yetti.response :as-alias yres]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware])
                       th/init-system))
(t/use-fixtures :each th/database-reset)

(defn- create-profile
  []
  (th/create-profile* (uuid/next) {:is-active true}))

(defn- create-mcp-token
  "Create a valid MCP token row for `profile` and return it."
  [profile]
  (db/tx-run! th/*system* access-token/create-access-token
              (:id profile) "MCP" nil "mcp"))

(defn- perms-of
  [token-id]
  (set (db/decode-pgarray (:perms (th/db-get :access-token {:id token-id})) [])))

(defn- set-perms!
  [token-id perms]
  (db/tx-run! th/*system*
              (fn [{:keys [::db/conn]}]
                (db/exec! conn ["UPDATE access_token SET perms = ? WHERE id = ?"
                                (db/create-array conn "text" perms)
                                token-id]))))

(defn- http-command
  "Send a JSON request to a main RPC method, with an MCP token when given."
  [command token params]
  ((#'http/router-handler (::http/router th/*system*))
   (th/make-dummy-request
    {:path (str "/api/main/methods/" command)
     :method :post
     :headers (cond-> {"content-type" "application/json"
                       "accept" "application/json"
                       "x-client" "penpot-mcp"}
                token (assoc "authorization" (str "Token " token)))
     :body-bytes (json/encode params)})))

(defn- reply-code
  "The `code` of an error reply, read from its JSON body."
  [reply]
  (let [out (java.io.ByteArrayOutputStream.)]
    (rcp/write-body-to-stream (::yres/body reply) nil out)
    (get (json/decode (str out)) "code")))

(defn- mcp-call
  "Run a command as an MCP caller holding `perms`."
  [profile command perms params]
  (th/command! (merge {::th/type command
                       ::rpc/profile-id (:id profile)
                       ::rpc/auth-type :token
                       ::rpc/token-type "mcp"
                       ::rpc/token-perms perms}
                      params)))

(defn- error-type
  [out]
  (:type (ex-data (:error out))))

(defn- error-code
  [out]
  (:code (ex-data (:error out))))

;; Scope semantics (app.rpc.mcp-scope)

(t/deftest mcp-write-mcp-manage-and-mcp-delete-imply-read
  (doseq [scope ["mcp:write" "mcp:manage" "mcp:delete"]]
    (t/is (mcp-scope/granted? #{scope} "mcp:read"))))

(t/deftest mcp-write-does-not-imply-manage-or-delete
  (t/is (not (mcp-scope/granted? #{"mcp:write"} "mcp:manage")))
  (t/is (not (mcp-scope/granted? #{"mcp:write"} "mcp:delete")))
  (t/is (not (mcp-scope/granted? #{"mcp:manage"} "mcp:write"))))

(t/deftest token-without-mcp-scopes-holds-read-only
  (t/is (mcp-scope/granted? [] "mcp:read"))
  (t/is (not (mcp-scope/granted? [] "mcp:write")))
  (t/is (not (mcp-scope/granted? ["error-reports:read"] "mcp:write"))))

;; Authentication wrapper

(t/deftest mcp-token-runs-opted-in-commands
  (let [profile (create-profile)]
    (t/is (nil? (:error (mcp-call profile :get-teams #{} {}))))
    (t/is (nil? (:error (mcp-call profile :get-profile #{} {}))))))

(t/deftest mcp-token-is-refused-on-commands-not-opted-in
  (let [profile (create-profile)]
    (t/is (= :authorization (error-type (mcp-call profile :update-file #{"mcp:write"} {}))))
    (t/is (= :token-auth-required
             (error-code (mcp-call profile :get-access-tokens #{"mcp:manage"} {}))))))

(t/deftest session-user-runs-tagged-commands
  (let [profile (create-profile)
        team-id (:default-team-id profile)
        teams   (th/command! {::th/type :get-teams ::rpc/profile-id (:id profile)})
        project (th/command! {::th/type :create-project
                              ::rpc/profile-id (:id profile)
                              :team-id team-id
                              :name "Session project"})]
    (t/is (nil? (:error teams)))
    (t/is (nil? (:error project)))))

(t/deftest personal-token-is-not-checked-against-mcp-scopes
  (let [profile (create-profile)
        out     (th/command! {::th/type :get-teams
                              ::rpc/profile-id (:id profile)
                              ::rpc/auth-type :token
                              ::rpc/token-perms #{}})]
    (t/is (nil? (:error out)))))

;; The params must be valid: the scope check runs after params validation.
(def ^:private comment-thread-params
  {:file-id uuid/zero
   :page-id uuid/zero
   :frame-id uuid/zero
   :position {:x 0 :y 0}
   :content "Hello"})

(def ^:private project-params
  {:team-id uuid/zero
   :name "Project"})

(t/deftest empty-perms-are-refused-on-write-and-manage-commands
  (let [profile (create-profile)]
    (t/is (= :mcp-scope-required
             (error-code (mcp-call profile :create-comment-thread #{} comment-thread-params))))
    (t/is (= :mcp-scope-required
             (error-code (mcp-call profile :create-project #{} project-params))))))

(t/deftest write-scope-passes-the-wrapper-for-write-commands
  (let [profile (create-profile)
        out     (mcp-call profile :create-comment-thread #{"mcp:write"} {})]
    ;; The scope check passes, so the invalid params fail validation (400),
    ;; not authorization (403).
    (t/is (= :validation (error-type out)))))

(t/deftest write-scope-does-not-pass-manage-commands
  (let [profile (create-profile)]
    (t/is (= :mcp-scope-required
             (error-code (mcp-call profile :create-project #{"mcp:write"} project-params))))))

(t/deftest manage-scope-passes-the-wrapper-for-manage-commands
  (let [profile (create-profile)]
    (t/is (not= :mcp-scope-required
                (error-code (mcp-call profile :create-project #{"mcp:manage"} {}))))))

(t/deftest scope-function-sees-the-merged-params
  (let [wrapped (rpc/wrap-mcp-scope nil
                                    (fn [_ _] :ok)
                                    {::rpc/mcp-scope (fn [params]
                                                       (if (:dry-run params) "mcp:read" "mcp:write"))})
        base    {::rpc/token-type "mcp"
                 ::rpc/token-perms #{"mcp:read"}}]
    (t/is (= :ok (wrapped {} (assoc base :dry-run true))))
    (let [cause (try (wrapped {} (assoc base :dry-run false))
                     (catch clojure.lang.ExceptionInfo cause cause))]
      (t/is (= :authorization (th/ex-type cause)))
      (t/is (= :mcp-scope-required (th/ex-code cause))))))

;; Scopes over HTTP, through the router

(t/deftest read-only-token-is-refused-write-commands-over-http
  (let [profile (create-profile)
        token   (create-mcp-token profile)
        reply   (http-command "create-comment-thread" (:token token)
                              {:fileId (str uuid/zero)
                               :pageId (str uuid/zero)
                               :frameId (str uuid/zero)
                               :position {:x 0 :y 0}
                               :content "Hello"})]
    (t/is (= 403 (::yres/status reply)))
    (t/is (= "mcp-scope-required" (reply-code reply)))))

(t/deftest read-only-token-runs-read-commands-over-http
  (let [profile (create-profile)
        token   (create-mcp-token profile)
        reply   (http-command "get-teams" (:token token) {})]
    (t/is (not= 403 (::yres/status reply)))
    (t/is (= 200 (::yres/status reply)))))

;; Token management

(t/deftest update-mcp-token-scopes-replaces-mcp-scopes-only
  (let [profile (create-profile)
        token   (create-mcp-token profile)]
    (set-perms! (:id token) ["error-reports:read" "mcp:manage"])
    (let [out (th/command! {::th/type :update-mcp-token-scopes
                            ::rpc/profile-id (:id profile)
                            :scopes ["mcp:write"]})]
      (t/is (nil? (:error out)))
      (t/is (= ["mcp:read" "mcp:write"] (get-in out [:result :scopes])))
      (t/is (= #{"error-reports:read" "mcp:write"} (perms-of (:id token)))))))

(t/deftest update-mcp-token-scopes-rejects-unknown-scopes
  (let [profile (create-profile)]
    (create-mcp-token profile)
    (let [out (th/command! {::th/type :update-mcp-token-scopes
                            ::rpc/profile-id (:id profile)
                            :scopes ["mcp:admin"]})]
      (t/is (= :validation (error-type out))))))

(t/deftest update-mcp-token-scopes-requires-an-mcp-token
  (let [profile (create-profile)
        out     (th/command! {::th/type :update-mcp-token-scopes
                              ::rpc/profile-id (:id profile)
                              :scopes ["mcp:write"]})]
    (t/is (= :not-found (error-type out)))
    (t/is (= :mcp-token-not-found (error-code out)))))

(t/deftest update-mcp-token-scopes-refuses-mcp-callers-over-http
  (let [profile (create-profile)
        token   (create-mcp-token profile)
        reply   (http-command "update-mcp-token-scopes" (:token token) {:scopes ["mcp:write"]})]
    (t/is (= 403 (::yres/status reply)))
    (t/is (= #{"mcp:read"} (mcp-scope/effective-scopes (perms-of (:id token)))))))

(t/deftest get-access-tokens-shows-mcp-scopes
  (let [profile (create-profile)
        token   (create-mcp-token profile)
        _       (th/command! {::th/type :update-mcp-token-scopes
                              ::rpc/profile-id (:id profile)
                              :scopes ["mcp:write"]})
        out     (th/command! {::th/type :get-access-tokens ::rpc/profile-id (:id profile)})
        row     (first (filter #(= (:id token) (:id %)) (:result out)))]
    (t/is (nil? (:error out)))
    (t/is (= ["mcp:read" "mcp:write"] (:scopes row)))))

(t/deftest new-mcp-token-holds-read-scope-only
  (let [profile (create-profile)
        out     (th/command! {::th/type :get-access-tokens ::rpc/profile-id (:id profile)})]
    (t/is (empty? (:result out)))
    (let [token (create-mcp-token profile)
          row   (first (filter #(= (:id token) (:id %))
                               (:result (th/command! {::th/type :get-access-tokens
                                                      ::rpc/profile-id (:id profile)}))))]
      (t/is (= ["mcp:read"] (:scopes row))))))

(t/deftest mcp-token-max-age-gives-new-mcp-tokens-an-expiry
  (let [profile (create-profile)]
    (with-redefs [cf/config (assoc cf/config :mcp-token-max-age (ct/duration "1h"))]
      (let [token (create-mcp-token profile)]
        (t/is (some? (:expires-at token)))
        (t/is (ct/is-after? (ct/in-future "2h") (:expires-at token)))
        (t/is (ct/is-after? (:expires-at token) (ct/in-future "30m")))))))

(t/deftest mcp-token-max-age-is-unset-by-default
  (let [profile (create-profile)]
    (t/is (nil? (:expires-at (create-mcp-token profile))))))

(t/deftest mcp-token-max-age-does-not-touch-personal-tokens
  (let [profile (create-profile)]
    (with-redefs [cf/config (assoc cf/config :mcp-token-max-age (ct/duration "1h"))]
      (let [token (db/tx-run! th/*system* access-token/create-access-token
                              (:id profile) "personal" nil nil)]
        (t/is (nil? (:expires-at token)))))))
