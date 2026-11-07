;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-guard-test
  "RPC guards for MCP tokens: the backend mode flag, the request id header,
  refusal counting, the scope table at startup and the SSO cache key."
  (:require
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.metrics :as mtx]
   [app.nitrate :as nitrate]
   [app.rpc :as rpc]
   [app.rpc.mcp-scope :as mcp-scope]
   [app.util.services :as-alias sv]
   [backend-tests.helpers :as th]
   [clojure.test :as t]
   [yetti.response :as yres]))

(t/use-fixtures :once th/state-init)
(t/use-fixtures :each th/database-reset)

;; --- HELPERS

(def ^:private profile-counter (atom 1000))

(defn- real-profile-id
  "A profile that exists, so the MCP-enabled check finds its row."
  []
  (:id (th/create-profile* (swap! profile-counter inc))))

(defn- mcp-command
  "Runs the RPC command `cmd` as an MCP token of `perms`, for a profile that
  exists unless `params` names one."
  [cmd params & {:keys [perms]}]
  (th/command! (merge {::th/type cmd
                       ::rpc/profile-id (real-profile-id)
                       ::rpc/auth-type :token
                       ::rpc/token-type "mcp"
                       ::rpc/token-perms (or perms #{"mcp:read"})}
                      params)))

(defn- refusal-reasons
  "The `reason` labels of the refusal counter while `f` runs."
  [f]
  (let [seen (atom [])]
    (with-redefs [mtx/run! (fn [_ & {:keys [id labels]}]
                             (when (= id :mcp-refusals-total)
                               (swap! seen conj (vec labels))))]
      (f))
    @seen))

(defn- ex-code-of
  [out]
  (some-> (:error out) th/ex-code))

;; --- BACKEND MODE FLAG

(t/deftest backend-mode-off-refuses-opened-commands-to-mcp-tokens
  (with-redefs [cf/flags (disj cf/flags :mcp-backend)]
    (let [out     (atom nil)
          reasons (refusal-reasons
                   #(reset! out (mcp-command :get-projects {})))]
      (t/is (= :restriction (th/ex-type (:error @out))))
      (t/is (= :mcp-backend-disabled (ex-code-of @out)))
      (t/is (= [["backend-disabled"]] reasons)))))

(t/deftest backend-mode-off-refuses-an-mcp-only-read
  (with-redefs [cf/flags (disj cf/flags :mcp-backend)]
    (let [out     (atom nil)
          reasons (refusal-reasons #(reset! out (mcp-command :get-mcp-tokens {})))]
      (t/is (= :restriction (th/ex-type (:error @out))))
      (t/is (= :mcp-backend-disabled (ex-code-of @out)))
      (t/is (= [["backend-disabled"]] reasons)))))

(t/deftest backend-mode-off-refuses-an-mcp-only-write
  (with-redefs [cf/flags (disj cf/flags :mcp-backend)]
    (let [out     (atom nil)
          reasons (refusal-reasons
                   #(reset! out (mcp-command :mcp-apply-changes {:file-id (uuid/next)
                                                                 :changes []}
                                             :perms #{"mcp:write"})))]
      (t/is (= :restriction (th/ex-type (:error @out))))
      (t/is (= :mcp-backend-disabled (ex-code-of @out)))
      (t/is (= [["backend-disabled"]] reasons)))))

(t/deftest backend-mode-off-keeps-the-bridge-reachable
  (with-redefs [cf/flags (disj cf/flags :mcp-backend)]
    (let [out (mcp-command :send-mcp-feedback {:subject "s" :feedback "f"})]
      (t/is (not= :mcp-backend-disabled (ex-code-of out))))))

(t/deftest token-fingerprint-is-eight-hex-chars-of-the-token-id
  (let [id (uuid/next)]
    (t/is (nil? (mcp-scope/token-fingerprint nil)))
    (t/is (re-matches #"[0-9a-f]{8}" (mcp-scope/token-fingerprint id)))
    (t/is (= (mcp-scope/token-fingerprint id) (mcp-scope/token-fingerprint id)))
    (t/is (not= (mcp-scope/token-fingerprint id)
                (mcp-scope/token-fingerprint (uuid/next))))))

(t/deftest backend-mode-on-lets-opened-commands-past-the-gate
  (with-redefs [cf/flags (conj cf/flags :mcp-backend)]
    (let [out (mcp-command :get-projects {})]
      (t/is (not= :mcp-backend-disabled (ex-code-of out))))))

;; --- REQUEST ID

(defn- echo-handler
  "An RPC handler with one method that answers the request id."
  []
  (rpc/make-rpc-handler
   {:echo [{} (fn [params] {:request-id (str (::rpc/request-id params))})]}))

(defn- echoed-id
  [header]
  (let [request (-> (th/make-dummy-request
                     {:path "/api/main/methods/echo"
                      :method :post
                      :headers (cond-> {}
                                 (some? header)
                                 (assoc "x-request-id" header))})
                    (assoc :path-params {:method-name "echo"}))]
    (:request-id (::yres/body ((echo-handler) request)))))

(def ^:private generated-id-re
  #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

(t/deftest request-id-header-is-used-when-it-is-safe
  (t/is (= "trace.id-1_2" (echoed-id "trace.id-1_2")))
  (t/is (= (apply str (repeat 64 "a")) (echoed-id (apply str (repeat 64 "a"))))))

(t/deftest request-id-header-is-ignored-when-it-is-not-safe
  (t/is (re-matches generated-id-re (echoed-id nil)))
  (t/is (re-matches generated-id-re (echoed-id "")))
  (t/is (re-matches generated-id-re (echoed-id "bad id")))
  (t/is (re-matches generated-id-re (echoed-id "a;DROP")))
  (t/is (re-matches generated-id-re (echoed-id (apply str (repeat 65 "a"))))))

;; --- REFUSAL COUNTING

(t/deftest scope-refusal-is-counted
  (let [cfg    {::mtx/metrics :stub}
        mdata  {::sv/name "write-thing" ::rpc/mcp-scope "mcp:write"}
        f      (fn [_ _] :ok)
        wrapped (rpc/wrap-mcp-scope cfg f mdata)
        reasons (refusal-reasons
                 #(try (wrapped cfg {::rpc/token-type "mcp"
                                     ::rpc/token-perms #{"mcp:read"}})
                       (catch Exception _ nil)))]
    (t/is (= [["scope"]] reasons))))

(t/deftest session-restriction-refusal-is-counted
  (let [cfg     {::mtx/metrics :stub}
        mdata   {::sv/name "update-file"}
        f       (fn [_ _] :ok)
        wrapped (#'rpc/wrap-session-restriction cfg f mdata)
        reasons (refusal-reasons
                 #(try (wrapped cfg {::rpc/session-restriction {:file-ids #{}}})
                       (catch Exception _ nil)))]
    (t/is (= [["restricted"]] reasons))))

;; --- STARTUP SCOPE CHECK

(t/deftest mcp-commands-without-a-scope-are-refused-at-startup
  (t/is (thrown? IllegalStateException
                 (#'rpc/check-mcp-scope! {::sv/name "apply-thing" ::rpc/token-type "mcp"})))
  (t/is (thrown? IllegalStateException
                 (#'rpc/check-mcp-scope! {::sv/name "open-thing" ::rpc/allow-token-types #{"mcp"}})))
  (t/is (nil? (#'rpc/check-mcp-scope! {::sv/name "apply-thing" ::rpc/token-type "mcp"
                                       ::rpc/mcp-scope "mcp:write"})))
  (t/is (nil? (#'rpc/check-mcp-scope! {::sv/name "plain-thing"}))))

(defn- declared-scope
  [mdata]
  (let [scope (::rpc/mcp-scope mdata)]
    ;; A function scope depends on the params. The empty params give the
    ;; scope of an ordinary call.
    (if (fn? scope) (scope {}) scope)))

(defn- mcp-command?
  [mdata]
  (or (= "mcp" (::rpc/token-type mdata))
      (contains? (set (::rpc/allow-token-types mdata)) "mcp")))

(def ^:private expected-mcp-scopes
  "Every command an MCP token may reach, and the scope it declares."
  {"import-binfile" "mcp:manage"
   "get-comment-threads" "mcp:read"
   "get-comments" "mcp:read"
   "create-comment-thread" "mcp:write"
   "update-comment-thread" "mcp:write"
   "create-comment" "mcp:write"
   "delete-comment-thread" "mcp:delete"
   "delete-comment" "mcp:delete"
   "update-comment-thread-position" "mcp:write"
   "send-mcp-feedback" "mcp:read"
   "get-project-files" "mcp:read"
   "get-team-shared-files" "mcp:read"
   "get-team-recent-files" "mcp:read"
   "get-team-deleted-files" "mcp:read"
   "rename-file" "mcp:manage"
   "set-file-shared" "mcp:manage"
   "delete-file" "mcp:delete"
   "link-file-to-library" "mcp:manage"
   "unlink-file-from-library" "mcp:manage"
   "restore-deleted-team-files" "mcp:manage"
   "create-file" "mcp:manage"
   "get-file-snapshots" "mcp:read"
   "create-file-snapshot" "mcp:write"
   "restore-file-snapshot" "mcp:delete"
   "update-file-snapshot" "mcp:write"
   "delete-file-snapshot" "mcp:delete"
   "lock-file-snapshot" "mcp:write"
   "unlock-file-snapshot" "mcp:write"
   "duplicate-file" "mcp:manage"
   "duplicate-project" "mcp:manage"
   "move-files" "mcp:manage"
   "move-project" "mcp:manage"
   "mcp-whoami" "mcp:read"
   "get-mcp-file-outline" "mcp:read"
   "get-mcp-page-tree" "mcp:read"
   "get-mcp-shapes" "mcp:read"
   "find-mcp-shapes" "mcp:read"
   "get-mcp-library" "mcp:read"
   "get-mcp-tokens" "mcp:read"
   "create-mcp-render-session" "mcp:read"
   "mcp-apply-changes" "mcp:write"
   "mcp-apply-operations" "mcp:write"
   "mcp-import-svg" "mcp:write"
   "upload-file-media-object" "mcp:write"
   "create-file-media-object-from-url" "mcp:write"
   "get-projects" "mcp:read"
   "create-project" "mcp:manage"
   "update-project-pin" "mcp:manage"
   "rename-project" "mcp:manage"
   "delete-project" "mcp:delete"
   "search-files" "mcp:read"
   "get-teams" "mcp:read"
   "create-team" "mcp:manage"
   "update-team" "mcp:manage"})

(t/deftest mcp-method-table-declares-expected-scopes
  (let [actual (into {}
                     (for [[k [mdata _]] (:app.rpc/methods th/*system*)
                           :when (mcp-command? mdata)]
                       [(name k) (declared-scope mdata)]))]
    (t/is (= expected-mcp-scopes actual))))

;; --- SSO CACHE KEY

(t/deftest sso-cache-is-kept-apart-per-credential-kind
  (let [profile-id (uuid/next)
        team-id    (uuid/next)
        allowed    (atom true)
        calls      (atom 0)
        session    {::rpc/profile-id profile-id ::rpc/auth-type :session :team-id team-id}
        token      {::rpc/profile-id profile-id ::rpc/auth-type :token :team-id team-id}
        wrapped    (with-redefs [cf/flags (conj cf/flags :admin-console)]
                     (#'rpc/wrap-nitrate-sso {} (fn [_ _] :ok) {::sv/name "get-team"}))
        call       (fn [params]
                     (try
                       (wrapped {} params)
                       (catch Exception e
                         (:code (ex-data e)))))]
    (with-redefs [nitrate/sso-session-authorized?
                  (fn [& _]
                    (swap! calls inc)
                    {:authorized @allowed :sso nil})]
      ;; The owner's browser session passes and fills the cache.
      (t/is (= :ok (call session)))
      ;; The same profile and team, now refused for the browser session.
      (reset! allowed false)
      ;; An MCP token call must not reuse the browser session's entry.
      (t/is (= :nitrate-sso-required (call token)))
      (t/is (= 2 @calls))
      ;; The browser session still reads its own entry.
      (t/is (= :ok (call session)))
      (t/is (= 2 @calls)))))

(t/deftest profile-with-mcp-off-refuses-every-mcp-call-but-the-bridge
  ;; The token lookup sets the profile's MCP switch on the request. The
  ;; route-level test covers that path end to end.
  (let [profile (th/create-profile* 1 {:is-active true})
        params  {::rpc/profile-id (:id profile) ::rpc/mcp-enabled false}
        opened  (atom nil)
        reasons (refusal-reasons #(reset! opened (mcp-command :get-projects params)))]
    (t/is (= :restriction (th/ex-type (:error @opened))))
    (t/is (= :mcp-disabled (ex-code-of @opened)))
    (t/is (= [["mcp-disabled"]] reasons))
    (t/is (not= :mcp-disabled
                (ex-code-of (mcp-command :send-mcp-feedback
                                         (assoc params :subject "s" :feedback "f")))))))

(t/deftest profile-with-mcp-on-is-not-refused-as-disabled
  (let [profile (th/create-profile* 1 {:is-active true})
        out     (mcp-command :get-projects {::rpc/profile-id (:id profile)})]
    (t/is (not= :mcp-disabled (ex-code-of out)))))
