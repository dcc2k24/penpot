;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.access-token
  (:require
   [app.common.exceptions :as ex]
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.http.access-token :as actoken]
   [app.main :as-alias main]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.profile :as profile]
   [app.rpc.doc :as-alias doc]
   [app.rpc.mcp-scope :as mcp-scope]
   [app.rpc.quotes :as quotes]
   [app.setup :as-alias setup]
   [app.tokens :as tokens]
   [app.util.services :as sv]))

(defn- decode-row
  [row]
  (dissoc row :perms))

(defn- mcp-scopes
  "Sorted scope strings an MCP token with `perms` (a seq of strings) holds."
  [perms]
  (vec (sort (mcp-scope/effective-scopes perms))))

;; The hand-made token has no client. Its regeneration and scope edits
;; never touch the tokens of OAuth clients (client_id not NULL).
(def ^:private sql:clean-old-mcp-tokens
  "DELETE FROM access_token
    WHERE profile_id = ?
      AND id != ?
      AND type = 'mcp'
      AND client_id IS NULL")

(def ^:private sql:get-valid-mcp-token
  "SELECT * FROM access_token
    WHERE profile_id = ?
      AND type = 'mcp'
      AND client_id IS NULL
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY created_at DESC
    LIMIT 1")

;; Most connected clients one profile may hold. A further client is refused.
(def ^:const max-client-mcp-tokens 20)

(def ^:private sql:count-other-client-mcp-tokens
  "SELECT count(*) AS total
     FROM access_token
    WHERE profile_id = ?
      AND type = 'mcp'
      AND client_id IS NOT NULL
      AND client_id <> ?")

(def ^:private sql:delete-client-mcp-tokens
  "DELETE FROM access_token
    WHERE profile_id = ?
      AND client_id = ?
      AND type = 'mcp'")

(def ^:private sql:update-token-perms
  "UPDATE access_token
      SET perms = ?,
          updated_at = now()
    WHERE id = ?")

(defn- insert-access-token!
  "Insert one access token row and return it. `client` is nil for the
  hand-made tokens, or a map with `:client-id`, `:client-name` and `:perms`
  for the token of an OAuth client. Expiry: an explicit `expiration`, or the
  configured MCP lifetime for MCP tokens."
  [{:keys [::db/conn] :as cfg} profile-id name expiration type client]
  (let [token-id   (uuid/next)
        expiration (or expiration
                       (when (= type "mcp")
                         (cf/get-mcp-token-max-age)))
        expires-at (some-> expiration (ct/in-future))
        created-at (ct/now)
        token-iss  (if (= type "mcp") actoken/mcp-token-issuer "access-token")
        token      (tokens/generate cfg {:iss token-iss
                                         :uid profile-id
                                         :iat created-at
                                         :tid token-id})]
    (db/insert! conn :access-token
                (cond-> {:id token-id
                         :name name
                         :token token
                         :type type
                         :profile-id profile-id
                         :created-at created-at
                         :updated-at created-at
                         :expires-at expires-at
                         :perms (db/create-array conn "text" (or (:perms client) []))}
                  (some? client)
                  (assoc :client-id (:client-id client)
                         :client-name (:client-name client))))))

(defn create-access-token
  "Create an access token with empty perms.

  An MCP token without an explicit `expiration` gets the configured
  `:mcp-token-max-age`, when there is one.

  Elevated permissions (e.g. error-reports:read) are not assignable via
  the public API; grant them with SQL or `repl:grant-access-token-perm`."
  [{:keys [::db/conn] :as cfg} profile-id name expiration type]
  ;; Serialize regeneration with OAuth provisioning for the same profile.
  (when (= type "mcp")
    (db/get-by-id conn :profile profile-id {::db/for-update true}))
  (let [token (insert-access-token! cfg profile-id name expiration type nil)]
    ;; A new hand-made MCP token replaces the older hand-made ones. The
    ;; client tokens stay.
    (when (= type "mcp")
      (db/exec! conn [sql:clean-old-mcp-tokens profile-id (:id token)]))

    (decode-row token)))

(defn grant-client-mcp-scopes
  "Enable MCP, then give OAuth client `client-id` one MCP token that holds
  exactly the effective `scopes`, with the configured expiry. An earlier
  token of the same client is replaced. The hand-made token and the tokens
  of other clients are not touched. Returns the new row. Must run in a
  transaction: the profile lock covers the change."
  [{:keys [::db/conn] :as cfg} profile-id client-id client-name scopes]
  (let [profile (profile/get-profile conn profile-id ::db/for-update true)]
    (when-not (:mcp-enabled (:props profile))
      (profile/update-profile-props cfg profile-id {:mcp-enabled true})))
  (let [{:keys [total]} (db/exec-one! conn [sql:count-other-client-mcp-tokens
                                            profile-id client-id])]
    (when (>= total max-client-mcp-tokens)
      (ex/raise :type :restriction
                :code :mcp-client-limit
                :hint "too many connected MCP clients for this profile"
                :limit max-client-mcp-tokens)))
  (db/exec! conn [sql:delete-client-mcp-tokens profile-id client-id])
  (let [name  (or client-name client-id)
        perms (mcp-scopes scopes)]
    (-> (insert-access-token! cfg profile-id name nil "mcp"
                              {:client-id client-id
                               :client-name client-name
                               :perms perms})
        (decode-row))))

(defn repl:create-access-token
  [cfg profile-id name expiration]
  (db/tx-run! cfg create-access-token profile-id name expiration))

(def ^:private sql:grant-access-token-perm
  "UPDATE access_token
      SET perms = (
            SELECT ARRAY(
              SELECT DISTINCT unnest(perms || ARRAY[?]::text[])
            )
          ),
          updated_at = now()
    WHERE id = ?
RETURNING id, perms")

(defn repl:grant-access-token-perm
  "Append a permission string to an access token (operator/SQL path).

  Example: (repl:grant-access-token-perm cfg token-id \"error-reports:read\")"
  [cfg token-id perm]
  (db/tx-run! cfg
              (fn [{:keys [::db/conn]}]
                (let [row (db/exec-one! conn [sql:grant-access-token-perm perm token-id])]
                  (some-> row (update :perms db/decode-pgarray #{}))))))

(def ^:private schema:create-access-token
  [:map {:title "create-access-token"}
   [:name [:string {:max 250 :min 1}]]
   [:expiration {:optional true} ::ct/duration]
   [:type {:optional true} :string]])

(sv/defmethod ::create-access-token
  {::doc/added "1.18"
   ::sm/params schema:create-access-token}
  [cfg {:keys [::rpc/profile-id name expiration type]}]

  (quotes/check! cfg {::quotes/id ::quotes/access-tokens-per-profile
                      ::quotes/profile-id profile-id})

  (db/tx-run! cfg create-access-token profile-id name expiration type))

(def ^:private schema:delete-access-token
  [:map {:title "delete-access-token"}
   [:id ::sm/uuid]])

(sv/defmethod ::delete-access-token
  {::doc/added "1.18"
   ::sm/params schema:delete-access-token}
  [{:keys [::db/pool]} {:keys [::rpc/profile-id id]}]
  (db/delete! pool :access-token {:id id :profile-id profile-id})
  nil)

(def ^:private schema:get-access-tokens
  [:map {:title "get-access-tokens"}])

(sv/defmethod ::get-access-tokens
  {::doc/added "1.18"
   ::sm/params schema:get-access-tokens}
  [{:keys [::db/pool]} {:keys [::rpc/profile-id]}]
  (->> (db/query pool :access-token
                 {:profile-id profile-id}
                 {:order-by [[:expires-at :asc] [:created-at :asc]]
                  :columns [:id :name :perms :type :created-at :updated-at :expires-at :token
                            :client-id :client-name]})
       (map (fn [{:keys [type perms] :as row}]
              (cond-> (decode-row row)
                (= type "mcp") (assoc :scopes (mcp-scopes (db/decode-pgarray perms []))))))
       ;; Only the hand-made MCP token shows its secret. Client tokens
       ;; never do: the settings page does not show them.
       (map (fn [{:keys [type client-id] :as row}]
              (if (or (not= type "mcp") (some? client-id))
                (dissoc row :token)
                row)))
       (vec)))

(defn- update-mcp-token-scopes
  "Replace the `mcp:*` perms of the profile's valid MCP token. Other perms
  stay. The profile lock serializes this with the token regeneration."
  [{:keys [::db/conn]} profile-id scopes]
  (db/get-by-id conn :profile profile-id {::db/for-update true})
  (let [token (db/exec-one! conn [sql:get-valid-mcp-token profile-id])]
    (when-not token
      (ex/raise :type :not-found
                :code :mcp-token-not-found
                :hint "the profile has no valid MCP token"))
    (let [perms (-> (db/decode-pgarray (:perms token) [])
                    (mcp-scope/replace-scopes scopes))]
      (db/exec! conn [sql:update-token-perms
                      (db/create-array conn "text" perms)
                      (:id token)])
      {:id (:id token)
       :scopes (mcp-scopes perms)})))

(def ^:private schema:update-mcp-token-scopes
  [:map {:title "update-mcp-token-scopes"}
   [:scopes [::sm/vec [:enum "mcp:read" "mcp:write" "mcp:manage" "mcp:delete"]]]])

(sv/defmethod ::update-mcp-token-scopes
  "Replace the scopes of the caller's MCP token. Session auth only: MCP
  tokens cannot run it, because the command has no MCP opt-in."
  {::doc/added "2.21"
   ::rpc/session-only true
   ::sm/params schema:update-mcp-token-scopes}
  [cfg {:keys [::rpc/profile-id scopes] :as params}]
  (when (= :token (::rpc/auth-type params))
    (ex/raise :type :authorization
              :code :session-required
              :hint "only a session can change the MCP token scopes"))
  (db/tx-run! cfg update-mcp-token-scopes profile-id scopes))

(def ^:private schema:get-current-mcp-token
  [:map {:title "get-current-mcp-token"}])

(sv/defmethod ::get-current-mcp-token
  {::doc/added "2.15"
   ::doc/deprecated true
   ::sm/params schema:get-current-mcp-token}
  [{:keys [::db/pool]} {:keys [::rpc/profile-id ::rpc/request-at]}]
  (->> (db/exec! pool
                 ["SELECT token, expires_at FROM access_token
                    WHERE profile_id = ?
                      AND type = 'mcp'
                      AND client_id IS NULL
                    ORDER BY expires_at ASC NULLS LAST, created_at ASC"
                  profile-id])
       (remove #(and (some? (:expires-at %))
                     (ct/is-after? request-at (:expires-at %))))
       (map decode-row)
       (first)))
