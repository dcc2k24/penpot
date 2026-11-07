;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc
  (:require
   [app.auth.ldap :as-alias ldap]
   [app.common.data :as d]
   [app.common.exceptions :as ex]
   [app.common.logging :as l]
   [app.common.schema :as sm]
   [app.common.spec :as us]
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.http :as-alias http]
   [app.http.access-token :as actoken]
   [app.http.client :as-alias http.client]
   [app.http.middleware :as mw]
   [app.http.security :as sec]
   [app.http.session :as session]
   [app.loggers.audit :as audit]
   [app.main :as-alias main]
   [app.metrics :as mtx]
   [app.msgbus :as-alias mbus]
   [app.nitrate :as nitrate]
   [app.redis :as rds]
   [app.rpc.climit :as climit]
   [app.rpc.commands.teams :as teams]
   [app.rpc.cond :as cond]
   [app.rpc.doc :as doc]
   [app.rpc.helpers :as rph]
   [app.rpc.mcp-scope :as mcp-scope]
   [app.rpc.retry :as retry]
   [app.rpc.rlimit :as rlimit]
   [app.setup :as-alias setup]
   [app.storage :as-alias sto]
   [app.util.cache :as cache]
   [app.util.inet :as inet]
   [app.util.services :as sv]
   [clojure.set :as set]
   [clojure.spec.alpha :as s]
   [cuerdas.core :as str]
   [integrant.core :as ig]
   [yetti.request :as yreq]
   [yetti.response :as yres]))

(s/def ::profile-id ::us/uuid)

(defn- default-handler
  [_]
  (ex/raise :type :not-found))

(defn- handle-response-transformation
  [response request mdata]
  (reduce (fn [response transform-fn]
            (transform-fn request response))
          response
          (::response-transform-fns mdata)))

(defn- handle-before-comple-hook
  [response mdata]
  (doseq [hook-fn (::before-complete-fns mdata)]
    (ex/ignoring (hook-fn)))
  response)

(defn- handle-response
  [request result]
  (let [mdata    (meta result)
        response (if (fn? result)
                   (result request)
                   (let [result  (rph/unwrap result)
                         status  (or (::http/status mdata)
                                     (if (nil? result)
                                       204
                                       200))

                         headers (::http/headers mdata {})
                         headers (cond-> headers
                                   (and (yres/stream-body? result)
                                        (not (contains? headers "content-type")))
                                   (assoc "content-type" "application/octet-stream"))]

                     {::yres/status  status
                      ::yres/headers headers
                      ::yres/body    result}))]

    (-> response
        (handle-response-transformation request mdata)
        (handle-before-comple-hook mdata))))

(defn- request-id-header
  "The request id a client sent in `x-request-id`, or nil. A usable id is
  1 to 64 chars of letters, digits, dot, underscore or dash. Anything else
  is ignored, so a client cannot write odd text into the logs."
  [request]
  (let [value (yreq/get-header request "x-request-id")]
    (when (and (string? value)
               (re-matches #"[A-Za-z0-9._-]{1,64}" value))
      value)))

(defn make-rpc-handler
  "Ring handler that dispatches cmd requests and convert between
  internal async flow into ring async flow."
  [methods]
  (let [methods (update-vals methods peek)]
    (fn [{:keys [path-params method] :as request}]
      (let [handler-name (:method-name path-params)
            etag         (yreq/get-header request "if-none-match")
            session-id   (yreq/get-header request "x-session-id")

            key-id       (get request ::http/auth-key-id)
            session-pid  (::session/profile-id request)
            token-pid    (::actoken/profile-id request)
            profile-id   (or session-pid
                             token-pid
                             (if key-id uuid/zero nil))

            ip-addr      (inet/parse-request request)

            data         (-> {}
                             (assoc ::handler-name handler-name)
                             (assoc ::ip-addr ip-addr)
                             (assoc ::request-at (ct/now))
                             (assoc ::request-id (or (request-id-header request)
                                                     (uuid/next)))
                             (assoc ::session-id (some-> session-id uuid/parse*))
                             (assoc ::cond/key etag)
                             (cond-> (uuid? profile-id)
                               (assoc ::profile-id profile-id))
                             (cond-> (uuid? session-pid)
                               (assoc ::auth-type :session))
                             (cond-> (and (not (uuid? session-pid))
                                          (uuid? token-pid))
                               (-> (assoc ::auth-type :token)
                                   (assoc ::token-perms (set (::actoken/perms request #{})))
                                   (assoc ::token-type (::actoken/type request))
                                   (cond-> (some? (::actoken/mcp-enabled request))
                                     (assoc ::mcp-enabled (::actoken/mcp-enabled request)))))
                             (cond-> key-id
                               (assoc ::auth-key-id key-id))
                             ;; Server-side only, like the ids above: a
                             ;; restricted session (MCP render) cannot be
                             ;; widened from the body.
                             (cond-> (::session/restriction request)
                               (assoc ::session-restriction (::session/restriction request)))
                             ;; Server-side only: request bodies cannot forge
                             ;; it (qualified keys are stripped before the
                             ;; merge). Upload maps are only trusted when they
                             ;; arrive over multipart.
                             (assoc ::is-multipart
                                    (str/starts-with?
                                     (str (yreq/get-header request "content-type"))
                                     "multipart/")))

            data         (with-meta data
                           {::http/request request})

            handler-fn   (get methods (keyword handler-name) default-handler)]

        (when (and (or (= method :get)
                       (= method :head))
                   (not (str/starts-with? handler-name "get-")))
          (ex/raise :type :restriction
                    :code :method-not-allowed
                    :hint "method not allowed for this request"))

        ;; FIXME: why we have this cond enabled here, we need to move it outside this handler
        (binding [cond/*enabled* true]
          (let [response (handler-fn data)]
            (handle-response request response)))))))

(defn- wrap-metrics
  "Wrap service method with metrics measurement."
  [{:keys [::mtx/metrics ::metrics-id]} f mdata]
  (let [labels (into-array String [(::sv/name mdata)])]
    (fn [cfg params]
      (let [tp (ct/tpoint)]
        (try
          (f cfg params)
          (finally
            (mtx/run! metrics
                      :id metrics-id
                      :val (inst-ms (tp))
                      :labels labels)))))))

(defn- note-refusal!
  "Counts and logs one call the backend refused, by `reason`. The log line
  names the command, the token fingerprint and the request id. It never
  holds the token itself. These refusals happen before the audit and the
  metrics wrappers, so they are recorded here."
  [cfg reason mdata params]
  (when-let [metrics (::mtx/metrics cfg)]
    (mtx/run! metrics
              :id :mcp-refusals-total
              :labels [reason]
              :inc 1))
  (l/inf :hint "mcp refused"
         :reason reason
         :cmd (::sv/name mdata)
         :token-fp (mcp-scope/token-fingerprint
                    (-> (meta params) (get ::http/request) (get ::actoken/id)))
         :request-id (str (::request-id params))))

(defn- resolve-mcp-scope
  "The scope a request needs: `::mcp-scope` as given, or the value of
  the function it holds for these params. Commands that declare none need
  `mcp:read`."
  [scope-spec params]
  (cond
    (fn? scope-spec) (scope-spec params)
    (string? scope-spec) scope-spec
    :else mcp-scope/read-scope))

(defn- wrap-authentication
  "Check that the caller may run the command. Two metadata keys govern MCP
  tokens:

  - `::token-type \"mcp\"`: only MCP tokens may run the command.
  - `::allow-token-types #{\"mcp\"}`: MCP tokens may run it too, next to
    sessions and personal tokens.

  The scope an MCP token needs is checked by `wrap-mcp-scope`."
  [_ f mdata]
  (let [required-auth?      (::auth mdata true)
        required-auth-type  (::auth-type mdata)
        required-token-type (::token-type mdata)
        allow-token-types   (set (::allow-token-types mdata))
        required-perms      (into #{} (::perms mdata))
        bridge?             (true? (::mcp-bridge mdata))]
    (fn [cfg params]
      (let [profile-id  (::profile-id params)
            auth-type   (::auth-type params)
            token-type  (::token-type params)
            token-perms (set (::token-perms params #{}))]
        (cond
          (and required-auth? (not (uuid? profile-id)))
          (ex/raise :type :authentication
                    :code :authentication-required
                    :hint "authentication required for this endpoint")

          ;; With backend MCP mode off, an MCP token reaches no MCP command
          ;; except the bridge (`::mcp-bridge`, send-mcp-feedback). A
          ;; restriction, not an authentication error: the token is valid,
          ;; the adapter must not treat it as bad.
          (and (= token-type "mcp")
               (not bridge?)
               (not (contains? cf/flags :mcp-backend))
               (or (= required-token-type "mcp")
                   (contains? allow-token-types "mcp")))
          (do
            (note-refusal! cfg "backend-disabled" mdata params)
            (ex/raise :type :restriction
                      :code :mcp-backend-disabled
                      :hint "backend MCP mode is disabled"))

          (or (and (= required-auth-type :token)
                   (not= auth-type :token))
              (and required-token-type
                   (or (not= auth-type :token)
                       (not= required-token-type token-type)))
              (and (= token-type "mcp")
                   (not= required-token-type "mcp")
                   (not (contains? allow-token-types "mcp"))))
          (ex/raise :type :authorization
                    :code :token-auth-required
                    :hint "access token authentication required for this endpoint")

          ;; A profile that turned MCP off loses every MCP token at once,
          ;; the client tokens included, whatever the command. The flag comes
          ;; with the token row (see `app.http.access-token`), after the
          ;; token-type decision above.
          (and (= token-type "mcp")
               (not bridge?)
               (false? (::mcp-enabled params)))
          (do
            (note-refusal! cfg "mcp-disabled" mdata params)
            (ex/raise :type :restriction
                      :code :mcp-disabled
                      :hint "MCP is disabled for this profile"))

          (and (seq required-perms)
               (not= auth-type :token))
          (ex/raise :type :authorization
                    :code :token-auth-required
                    :hint "access token authentication required for this endpoint")

          (and (seq required-perms)
               (not (set/subset? required-perms token-perms)))
          (ex/raise :type :authorization
                    :code :missing-perms
                    :hint "missing required permissions"
                    :required required-perms)

          :else
          (f cfg params))))))

(defn wrap-mcp-scope
  "Check the scope of an MCP token against the command's `::mcp-scope`.
  Sessions and personal tokens are not checked. It sits inside
  `wrap-params-validation`, so a function scope sees the merged body params."
  [_ f mdata]
  (fn [cfg params]
    (when (= (::token-type params) "mcp")
      (let [perms (set (::token-perms params #{}))
            scope (resolve-mcp-scope (::mcp-scope mdata) params)]
        (when-not (mcp-scope/granted? perms scope)
          (note-refusal! cfg "scope" mdata params))
        (mcp-scope/check-scope! perms scope)))
    (f cfg params)))

(def ^:private render-session-commands
  "Reads a restricted (MCP render) session may make: the exporter's."
  #{:get-profile :get-team :get-font-variants :get-page :get-file
    :get-file-fragment :get-file-libraries})

(defn- render-scope?
  "True when `params` of command `cmd` name only files the restricted
  session covers. `get-team` and `get-font-variants` must name the file:
  their `id`, `team-id` and `project-id` params would read another team."
  [cmd params file-ids]
  (let [file-id (:file-id params)]
    (and (contains? render-session-commands cmd)
         (case cmd
           :get-profile       true
           :get-file          (contains? file-ids (:id params))
           :get-team          (and (contains? file-ids file-id)
                                   (nil? (:id params)))
           :get-font-variants (and (contains? file-ids file-id)
                                   (nil? (:team-id params))
                                   (nil? (:project-id params)))
           (contains? file-ids file-id)))))

(defn- wrap-session-restriction
  "Keep a restricted session (an MCP render, see `app.http.session`) to
  the render reads of the files it covers. The merged params carry
  `::session-restriction` only when the request authenticated with one.
  A call that also carries a shared key (`::auth-key-id`, the exporter
  uploading its render to the management API) is authenticated by that
  key, so the restriction does not apply to it.

  The session middleware already hides a render session from every route
  that does not opt in. This check is the second line of defence."
  [_ f mdata]
  (let [cmd (keyword (::sv/name mdata))]
    (fn [cfg params]
      (when-let [restriction (when-not (::auth-key-id params)
                               (::session-restriction params))]
        (when-not (render-scope? cmd params (:file-ids restriction))
          (note-refusal! cfg "restricted" mdata params)
          (ex/raise :type :authorization
                    :code :session-restricted
                    :hint "session is restricted to MCP render calls")))
      (f cfg params))))

(defn- wrap-db-transaction
  [_ f mdata]
  (if (::db/transaction mdata)
    (fn [cfg params]
      (db/tx-run! cfg f params))
    f))

(defn- wrap-audit
  [_ f mdata]
  (if (or (contains? cf/flags :webhooks)
          (contains? cf/flags :audit-log)
          (contains? cf/flags :telemetry))
    (if-not (::audit/skip mdata)
      (fn [cfg params]
        (let [result (f cfg params)]
          (->> (audit/prepare-rpc-event cfg mdata params result)
               (audit/submit cfg))
          result))
      f)
    f))

(defn- wrap-params-validation
  [_ f mdata]
  (if-let [schema (::sm/params mdata)]
    (let [validate (sm/validator schema)
          explain  (sm/explainer schema)
          decode   (sm/decoder schema sm/json-transformer)
          encode   (sm/encoder schema sm/json-transformer)]
      (fn [cfg params]
        (let [request-params (-> params meta ::http/request :params decode)]
          (if (validate request-params)
            (let [merged (merge params (d/without-qualified request-params))]
              ;; Upload temp files are created server-side by the multipart
              ;; parser, so an upload map smuggled in a transit/JSON body can
              ;; point :path at any internal server file. Methods declare
              ;; their upload keys with ::multipart-only-params and they are
              ;; only accepted when ::is-multipart arrived server-side with
              ;; the request (request bodies cannot forge qualified keys).
              (when (some #(and (contains? merged %)
                                (not (::is-multipart merged)))
                          (::multipart-only-params mdata))
                (ex/raise :type :validation
                          :code :params-validation
                          :hint "upload requires multipart"))
              (let [result (f cfg merged)]
                (if (instance? clojure.lang.IObj result)
                  (vary-meta result assoc :encode/json encode)
                  result)))
            (ex/raise :type :validation
                      :code :params-validation
                      ::sm/explain (explain request-params))))))
    f))


(defonce ^:private organization-sso-auth-cache
  (cache/create :expire "15m" :max-size 1024))

(defn invalidate-organization-sso-cache-by-organization!
  "Invalidates all organization-SSO authorization cache entries for the given organization-id."
  [organization-id]
  (cache/invalidate-if organization-sso-auth-cache #(= (:organization-id %) organization-id)))

(defn- wrap-nitrate-sso
  "Enforce Nitrate organization SSO authentication for RPC handlers.

   Resolves the organization/team context from request params:
   1. Explicit :organization-id param identifies the organization directly
   2. The team comes from the first available of: explicit :team-id, explicit
      :project-id -> lookup project.team_id, explicit :file-id -> lookup file's
      team via join, or the :id param dispatched by ::rpc/id-type metadata
      (:team, :project, or :file)

   Once the context is resolved, checks if the user is authorized within that organization's
   SSO session using nitrate/sso-session-authorized?, against the organization when it is
   known and against the team otherwise. The team is resolved either way, so the raised
   error can carry it. Authorized results are cached by [profile-id credential cache-ref]
   for 15 minutes to avoid repeated lookups. The credential is :session, :token or
   :restricted, so one kind of credential never reuses another's result.

   Only activates when:
   - Nitrate flag is enabled
   - Endpoint requires authentication (::auth true by default)
   - Endpoint is not marked with ::nitrate/organization-sso false

   Raises :nitrate-sso-required error if user is not authorized in the organization.
   The error carries the resolved :organization-id and :team-id so the client can
   restart the SSO flow (via :check-nitrate-sso) instead of reporting a plain
   permission failure."
  [_ f mdata]
  (if (and (contains? cf/flags :admin-console)
           (::auth mdata true) ;; only for endpoints that needs auth
           (::nitrate/sso mdata true))
    (fn [cfg params]
      ;; Resolve team/project/file from explicit keys or from :id via metadata
      (let [profile-id      (::profile-id params)
            organization-id (uuid/coerce (:organization-id params))
            id-type         (::id-type mdata)
            id              (uuid/coerce (:id params))
            team-id         (or (uuid/coerce (:team-id params))
                                (when (= id-type :team) id))
            project-id      (or (uuid/coerce (:project-id params))
                                (when (= id-type :project) id))
            file-id         (or (uuid/coerce (:file-id params))
                                (when (= id-type :file) id))]
        (if (and profile-id
                 (or organization-id team-id project-id file-id))
          (let [cache-ref  (or organization-id team-id project-id file-id)
                ;; The credential kind is part of the key. A token call must
                ;; not reuse a result the owner's browser session cached.
                credential (cond
                             (some? (::session-restriction params)) :restricted
                             (= :token (::auth-type params)) :token
                             :else :session)
                cache-key  [profile-id credential cache-ref]
                cached     (cache/get organization-sso-auth-cache cache-key)
                result     (if (some? cached)
                             cached
                             ;; The team is resolved even when the organization is
                             ;; already known: the client needs it to restart the
                             ;; SSO flow without sending non-members through the
                             ;; organization's identity provider.
                             (let [team-id                  (or team-id
                                                                (when project-id
                                                                  (:team-id (db/get-by-id cfg :project project-id {:columns [:id :team-id]})))
                                                                (when file-id
                                                                  (:id (teams/get-team-for-file cfg file-id))))
                                   request                  (-> (meta params) (get ::http/request))
                                   {:keys [authorized sso]} (if organization-id
                                                              (nitrate/sso-session-authorized? cfg organization-id nil request)
                                                              (nitrate/sso-session-authorized? cfg nil team-id request))
                                   entry                    {:authorized      authorized
                                                             :organization-id (or (:organization-id sso) organization-id)
                                                             :team-id         team-id}]
                               (when authorized
                                 (cache/get organization-sso-auth-cache cache-key (constantly entry)))
                               entry))]
            (if (:authorized result)
              (f cfg params)
              (ex/raise :type :authentication
                        :code :nitrate-sso-required
                        :organization-id (:organization-id result)
                        :team-id (:team-id result)
                        :hint "organization SSO authentication required")))
          (f cfg params))))
    f))

(defn- wrap
  [cfg f mdata]
  (as-> f $
    (wrap-db-transaction cfg $ mdata)
    (cond/wrap cfg $ mdata)
    (retry/wrap-retry cfg $ mdata)
    (climit/wrap cfg $ mdata)
    (wrap-metrics cfg $ mdata)
    (rlimit/wrap cfg $ mdata)
    (wrap-audit cfg $ mdata)
    (wrap-nitrate-sso cfg $ mdata)
    (wrap-mcp-scope cfg $ mdata)
    (wrap-session-restriction cfg $ mdata)
    (wrap-params-validation cfg $ mdata)
    (wrap-authentication cfg $ mdata)))

(defn- wrap-management
  [cfg f mdata]
  (as-> f $
    (wrap-db-transaction cfg $ mdata)
    (retry/wrap-retry cfg $ mdata)
    (climit/wrap cfg $ mdata)
    (wrap-metrics cfg $ mdata)
    (wrap-audit cfg $ mdata)
    (wrap-nitrate-sso cfg $ mdata)
    (wrap-mcp-scope cfg $ mdata)
    (wrap-session-restriction cfg $ mdata)
    (wrap-params-validation cfg $ mdata)
    (wrap-authentication cfg $ mdata)))

(defn- check-mcp-scope!
  "Throw at startup when an MCP command declares no `::mcp-scope`. Without
  one the scope falls back to `mcp:read`, so a later write command could
  fail open for read-only tokens. There is no allowance by name: a name
  prefix would let a future `get-mcp-...` command skip the check."
  [mdata]
  (let [cmd  (::sv/name mdata)
        mcp? (or (= "mcp" (::token-type mdata))
                 (contains? (set (::allow-token-types mdata)) "mcp"))]
    (when (and mcp? (nil? (::mcp-scope mdata)))
      (throw (IllegalStateException.
              (str "MCP command " cmd " declares no ::rpc/mcp-scope"))))))

(defn- process-method
  [cfg wrap-fn [f mdata]]
  (l/trc :hint "add method" :module (::module cfg) :type (::type cfg) :name (::sv/name mdata))
  (check-mcp-scope! mdata)
  (let [f (wrap-fn cfg f mdata)
        k (keyword (::sv/name mdata))]
    [k [mdata (partial f cfg)]]))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; API METHODS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- resolve-methods
  [cfg]
  (let [cfg (assoc cfg ::module "main" ::type "command" ::metrics-id :rpc-main-timing)]
    (->> (sv/scan-ns
          'app.rpc.commands.access-token
          'app.rpc.commands.audit
          'app.rpc.commands.auth
          'app.rpc.commands.feedback
          'app.rpc.commands.fonts
          'app.rpc.commands.binfile
          'app.rpc.commands.comments
          'app.rpc.commands.demo
          'app.rpc.commands.error-reports
          'app.rpc.commands.files
          'app.rpc.commands.files-create
          'app.rpc.commands.files-share
          'app.rpc.commands.files-update
          'app.rpc.commands.files-snapshot
          'app.rpc.commands.files-thumbnails
          'app.rpc.commands.jobs
          'app.rpc.commands.ldap
          'app.rpc.commands.management
          'app.rpc.commands.mcp
          'app.rpc.commands.mcp-write
          'app.rpc.commands.media
          'app.rpc.commands.nitrate
          'app.rpc.commands.plugins
          'app.rpc.commands.profile
          'app.rpc.commands.projects
          'app.rpc.commands.search
          'app.rpc.commands.teams
          'app.rpc.commands.teams-invitations
          'app.rpc.commands.verify-token
          'app.rpc.commands.viewer
          'app.rpc.commands.webhooks)
         (map (partial process-method cfg wrap))
         (into {}))))

(def ^:private schema:methods-params
  [:map {:title "methods-params"}
   ::session/manager
   ::http.client/client
   ::db/pool
   ::rds/pool
   ::mbus/msgbus
   ::sto/storage
   ::mtx/metrics
   [::ldap/provider [:maybe ::ldap/provider]]
   [::climit [:maybe ::climit]]
   [::rlimit [:maybe ::rlimit]]
   ::setup/props])

(defmethod ig/assert-key ::methods
  [_ params]
  (assert (sm/check schema:methods-params params)))

(defmethod ig/init-key ::methods
  [_ cfg]
  (let [cfg (d/without-nils cfg)]
    (resolve-methods cfg)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; MANAGEMENT METHODS
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- resolve-management-methods
  [cfg]
  (let [cfg  (assoc cfg ::module "management" ::type "command" ::metrics-id :rpc-management-timing)
        mods (cond->> (list 'app.rpc.management.exporter
                            'app.rpc.management.jobs
                            'app.rpc.management.files)
               (contains? cf/flags :admin-console)
               (cons 'app.rpc.management.nitrate))]

    (->> (apply sv/scan-ns mods)
         (map (partial process-method cfg wrap-management))
         (into {}))))

(def ^:private schema:management-methods-params
  [:map {:title "management-methods-params"}
   ::session/manager
   ::http.client/client
   ::db/pool
   ::rds/pool
   ::mbus/msgbus
   ::sto/storage
   ::mtx/metrics
   ::setup/props])

(defmethod ig/assert-key ::management-methods
  [_ params]
  (assert (sm/check schema:management-methods-params params)))

(defmethod ig/init-key ::management-methods
  [_ cfg]
  (let [cfg (d/without-nils cfg)]
    (resolve-management-methods cfg)))

;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;
;; ROUTES
;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;

(defn- redirect
  [href]
  (fn [_]
    {::yres/status 308
     ::yres/headers {"location" (str href)}}))

(def ^:private schema:methods
  [:map-of :keyword [:tuple :map ::sm/fn]])

(sm/register! ::methods schema:methods)

(def ^:private valid-methods?
  (sm/validator schema:methods))

(defmethod ig/assert-key ::routes
  [_ params]
  (assert (map? (::setup/shared-keys params)))
  (assert (db/pool? (::db/pool params)) "expect valid database pool")
  (assert (session/manager? (::session/manager params)) "expect valid session manager")
  (assert (valid-methods? (::methods params)) "expect valid methods map")
  (assert (valid-methods? (::management-methods params)) "expect valid methods map"))

(defmethod ig/init-key ::routes
  [_ {:keys [::methods ::management-methods ::setup/shared-keys] :as cfg}]
  ["/api"
   ["/management"
    ["/methods/:method-name"
     {:middleware [[mw/shared-key-auth shared-keys]
                   [session/authz (assoc cfg ::session/allow-restricted true)]]
      :handler (make-rpc-handler management-methods)}]

    (doc/routes :methods management-methods
                :label "management"
                :base-uri (cf/get-public-uri "api/management")
                :description "MANAGEMENT API")]

   ["/main"
    ["/methods/:method-name"
     {:middleware [[mw/cors]
                   [sec/client-header-check]
                   [session/authz (assoc cfg ::session/allow-restricted true)]
                   [actoken/authz (assoc cfg ::actoken/allow-mcp true)]]
      :handler (make-rpc-handler methods)}]

    (doc/routes :methods methods
                :label "main"
                :base-uri (cf/get-public-uri "api/main")
                :description "MAIN API")]

   ;; BACKWARD COMPATIBILITY
   ["/_doc" {:handler (redirect (cf/get-public-uri "api/main/doc"))}]
   ["/doc" {:handler (redirect (cf/get-public-uri "api/main/doc"))}]
   ["/openapi" {:handler (redirect (cf/get-public-uri "api/main/doc/openapi"))}]
   ["/openapi.join" {:handler (redirect (cf/get-public-uri "api/main/doc/openapi.json"))}]

   ["/rpc/command/:method-name"
    {:middleware [[mw/cors]
                  [sec/client-header-check]
                  [session/authz (assoc cfg ::session/allow-restricted true)]
                  [actoken/authz (assoc cfg ::actoken/allow-mcp true)]]
     :handler (make-rpc-handler methods)}]])
