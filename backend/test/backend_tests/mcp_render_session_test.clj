;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.mcp-render-session-test
  "Where an MCP render session may authenticate, and how its rows are
  cleaned up. The RPC restriction is tested in `rpc_mcp_read_test`."
  (:require
   [app.common.time :as ct]
   [app.config :as cf]
   [app.db :as db]
   [app.http :as http]
   [app.http.session :as session]
   [app.http.session.tasks :as-alias tasks]
   [app.rpc.commands.access-token :as access-token]
   [app.rpc.commands.profile :as profile]
   [app.storage :as sto]
   [backend-tests.helpers :as th]
   [clojure.test :as t]
   [yetti.response :as yres]))

(t/use-fixtures :once th/state-init)
(t/use-fixtures :each th/database-reset
  (fn [run]
    (binding [cf/config (assoc cf/config :tenant (str (java.util.UUID/randomUUID)))]
      (run))))

;; --- HELPERS

(defn- manager
  []
  (::session/manager th/*system*))

(defn- session-cfg
  "The config the session middleware reads, as an http route gets it."
  []
  {::session/manager (manager)
   ::db/pool (:app.db/pool th/*system*)})

(defn- token-row!
  "A real access token row of `profile`, as the exporter's render session
  points at. Returns its id."
  [profile]
  (:id (db/tx-run! th/*system* access-token/create-access-token
                   (:id profile) "token" nil nil)))

(defn- render-token
  "A cookie token for a render session of `profile` that covers `file-ids`.
  The session names a real token row, as `create-mcp-render-session` does,
  unless `token-id` is given."
  [profile & {:keys [file-ids token-id]
              :or   {file-ids #{}}}]
  (let [token-id (or token-id (token-row! profile))
        props    {:mcp-render {:file-ids file-ids}
                  :token-id token-id}
        session  (session/create-session (manager)
                                         {:profile-id (:id profile)
                                          :user-agent "penpot-mcp-exporter"
                                          :props props})]
    (:token (#'session/assign-token th/*system* session))))

(defn- plain-token
  [profile]
  (let [session (session/create-session (manager) {:profile-id (:id profile)})]
    (:token (#'session/assign-token th/*system* session))))

(defn- public-origin
  "The scheme and authority of the public URI, as a browser sends them."
  []
  (let [public (java.net.URI. (str (cf/get-public-uri)))]
    (str (.getScheme public) "://" (.getRawAuthority public))))

(defn- cookie
  [token]
  {(cf/get :auth-token-cookie-name "auth-token") token})

(defn- request
  [path & {:as options}]
  (let [handler (#'http/router-handler (:app.http/router th/*system*))]
    (handler (th/make-dummy-request (assoc options :path path)))))

(defn- status
  [& args]
  (::yres/status (apply request args)))

(defn- seen-profile
  "The profile the session middleware gives a route with `cfg` for `token`,
  or nil. Used for the routes whose config only the middleware sees."
  [cfg token]
  (let [handler (#'session/wrap-authz (fn [request] (::session/profile-id request)) cfg)
        claims  (session/decode-token th/*system* token)]
    (handler {::http/auth-data {:type :cookie :claims claims}})))

(defn- expire-token!
  [token-id]
  (db/update! th/*system* :access-token
              {:expires-at (ct/minus (ct/now) (ct/duration {:minutes 1}))}
              {:id token-id}))

(defn- age-session!
  [session-id created-at]
  (db/update! th/*system* :http-session-v2
              {:created-at created-at}
              {:id session-id}))

(defn- collect-expired!
  []
  (db/tx-run! th/*system*
              (fn [cfg]
                (#'session/collect-expired-tasks
                 (assoc cfg
                        ::tasks/max-age (ct/duration {:days 7})
                        ::tasks/max-age-absolute (ct/duration {:days 30}))))))

;; --- ROUTE TESTS, through the real handler

(t/deftest render-session-authenticates-as-nobody-on-oauth-approval
  (let [profile (th/create-profile* 1)
        token   (render-token profile)]
    (t/is (= 401 (status "/api/mcp/oauth/request" :cookies (cookie token))))
    (t/is (= 401 (status "/api/mcp/oauth/decision"
                         :method :post
                         :headers {"content-type" "application/x-www-form-urlencoded"
                                   "origin" (public-origin)}
                         :cookies (cookie token)
                         :body-bytes "decision=approve")))
    ;; Positive control: a plain login cookie is not refused for its login.
    (t/is (not= 401 (status "/api/mcp/oauth/request"
                            :cookies (cookie (plain-token profile)))))))

(t/deftest render-session-authenticates-as-nobody-on-websocket-route
  (let [profile (th/create-profile* 1)
        token   (render-token profile)
        params  {:session-id (str (java.util.UUID/randomUUID))}
        anon    (status "/ws/notifications" :params params)
        render  (status "/ws/notifications" :params params :cookies (cookie token))]
    ;; Same answer as an anonymous caller, and never a socket.
    (t/is (= anon render))
    (t/is (not= 101 render))))

(t/deftest render-session-authenticates-as-nobody-on-devenv-dbg
  ;; On a devenv host every profile passes the `/dbg` gate, so a leaked
  ;; render session would reach the debug console without this check.
  ;; `cf/config` is dynamic and the fixture binds it, so bind, not redef.
  (binding [cf/config (assoc cf/config :host "devenv")]
    (let [profile (th/create-profile* 1)
          token   (render-token profile)
          anon    (status "/dbg/health")
          render  (status "/dbg/health" :cookies (cookie token))
          plain   (status "/dbg/health" :cookies (cookie (plain-token profile)))]
      (t/is (= anon render))
      (t/is (= 200 plain)))))

(defn- media-of
  "A stored media object of `file` for the route tests."
  [file]
  (let [blob (sto/put-object! (:app.storage/storage th/*system*)
                              {::sto/content (sto/content "image data")
                               :bucket "file-media-object"
                               :content-type "image/svg+xml"})]
    (th/create-file-media-object* {:file-id (:id file)
                                   :media-id (:id blob)})))

(t/deftest render-session-reads-only-the-assets-of-its-files
  ;; The exporter reads its assets with the render cookie through /assets.
  ;; It reads media of its own file and is refused media of another file
  ;; of the same profile. The owner's plain cookie is the reference.
  (let [owner    (th/create-profile* 1)
        team     (th/create-team* 1 {:profile-id (:id owner)})
        project  (th/create-project* 1 {:profile-id (:id owner)
                                        :team-id (:id team)})
        file     (th/create-file* 1 {:profile-id (:id owner)
                                     :project-id (:id project)})
        other    (th/create-file* 2 {:profile-id (:id owner)
                                     :project-id (:id project)})
        own-path   (str "/assets/by-file-media-id/" (:id (media-of file)))
        other-path (str "/assets/by-file-media-id/" (:id (media-of other)))
        token      (render-token owner :file-ids #{(:id file)})
        plain      (cookie (plain-token owner))
        render     (cookie token)]
    (t/is (= 204 (status own-path :cookies plain)))
    (t/is (= 204 (status other-path :cookies plain)))
    (t/is (= 204 (status own-path :cookies render)))
    (t/is (= 404 (status other-path :cookies render)))))

;; --- HELPER TESTS, the session middleware with a hand-built config

(t/deftest render-session-is-hidden-from-routes-that-do-not-opt-in
  (let [profile (th/create-profile* 1)
        token   (render-token profile)
        cfg     (session-cfg)]
    (t/is (nil? (seen-profile cfg token)))
    (t/is (= (:id profile)
             (seen-profile (assoc cfg ::session/allow-restricted true) token)))))

(t/deftest render-session-of-a-deleted-token-does-not-authenticate
  (let [profile  (th/create-profile* 1)
        token-id (token-row! profile)
        token    (render-token profile :token-id token-id)
        cfg      (assoc (session-cfg) ::session/allow-restricted true)]
    (t/is (= (:id profile) (seen-profile cfg token)))
    (db/delete! th/*system* :access-token {:id token-id})
    (t/is (nil? (seen-profile cfg token)))))

(t/deftest render-session-of-an-expired-token-does-not-authenticate
  (let [profile  (th/create-profile* 1)
        token-id (token-row! profile)
        token    (render-token profile :token-id token-id)
        cfg      (assoc (session-cfg) ::session/allow-restricted true)]
    (t/is (= (:id profile) (seen-profile cfg token)))
    (expire-token! token-id)
    (t/is (nil? (seen-profile cfg token)))))

(t/deftest render-session-without-a-token-id-does-not-authenticate
  (let [profile (th/create-profile* 1)
        session (session/create-session (manager)
                                        {:profile-id (:id profile)
                                         :props {:mcp-render {:file-ids #{}}}})
        token   (:token (#'session/assign-token th/*system* session))
        cfg     (assoc (session-cfg) ::session/allow-restricted true)]
    (t/is (nil? (seen-profile cfg token)))))

;; --- GC

(t/deftest gc-deletes-old-render-sessions-only
  (let [profile    (th/create-profile* 1)
        manager    (manager)
        old-render (session/create-session manager
                                           {:profile-id (:id profile)
                                            :props {:mcp-render {:file-ids #{}}}})
        new-render (session/create-session manager
                                           {:profile-id (:id profile)
                                            :props {:mcp-render {:file-ids #{}}}})
        old-plain  (session/create-session manager {:profile-id (:id profile)})]
    (age-session! (:id old-render) (ct/minus (ct/now) (ct/duration {:minutes 11})))
    (age-session! (:id new-render) (ct/minus (ct/now) (ct/duration {:minutes 1})))
    (age-session! (:id old-plain) (ct/minus (ct/now) (ct/duration {:minutes 11})))
    (collect-expired!)
    (t/is (nil? (session/read-session manager (:id old-render))))
    (t/is (some? (session/read-session manager (:id new-render))))
    ;; A plain session has no render age, so the GC keeps it.
    (t/is (some? (session/read-session manager (:id old-plain))))))

(t/deftest render-session-stops-when-mcp-is-turned-off-for-its-profile
  (let [profile (th/create-profile* 1)
        token   (render-token profile)
        cfg     (assoc (session-cfg) ::session/allow-restricted true)]
    (t/is (= (:id profile) (seen-profile cfg token)))
    (db/tx-run! th/*system* profile/update-profile-props (:id profile) {:mcp-enabled false})
    (t/is (nil? (seen-profile cfg token)))))
