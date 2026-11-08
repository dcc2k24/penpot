;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.http.access-token
  (:require
   [app.common.logging :as l]
   [app.config :as cf]
   [app.db :as db]
   [app.http :as-alias http]
   [app.main :as-alias main]
   [app.setup :as-alias setup]
   [app.tokens :as tokens]))

(def mcp-token-issuer "urn:penpot:mcp-token")

(def ^:private valid-issuers
  #{"access-token" mcp-token-issuer})

(defn decode-token
  [cfg token]
  (try
    (let [claims (tokens/verify cfg {:token token})]
      (when (contains? valid-issuers (:iss claims))
        claims))
    ;; The cause is not logged because its data carries the token
    (catch Throwable _
      (l/trc :hint "exception on decoding token"))))

(def sql:get-token-data
  "SELECT perms, profile_id, expires_at, type
     FROM access_token
    WHERE id = ?
      AND (expires_at IS NULL
           OR (expires_at > now()));")

(def ^:private sql:get-profile-state
  "SELECT props, is_active, is_blocked, fullname, email
     FROM profile
    WHERE id = ?")

(defn- profile-state
  "The fields of the profile of an MCP token that the call checks: its
  props, whether it is active and whether it is blocked. Read once with
  the token and put on the request as `::profile`, so the command does not
  read the profile again. Nil when the profile cannot be read."
  [pool profile-id]
  (when-let [row (db/exec-one! pool [sql:get-profile-state profile-id])]
    (let [props (cond-> (:props row)
                  (db/pgobject? (:props row) "jsonb")
                  (db/decode-transit-pgobject))]
      {:props props
       :is-active (:is-active row)
       :is-blocked (:is-blocked row)
       :fullname (:fullname row)
       :email (:email row)})))

(defn- mcp-enabled-state?
  "Whether the profile state `state` has MCP on. A missing state is off."
  [state]
  (and (some? state)
       (not (false? (get-in state [:props :mcp-enabled])))))

(defn- get-token-data
  [pool claims]
  (when-not (db/read-only? pool)
    (when-let [token-id (get claims :tid)]
      (let [token       (db/exec-one! pool [sql:get-token-data token-id])
            mcp-claims? (= mcp-token-issuer (:iss claims))
            mcp-token?  (= "mcp" (:type token))]
        (when (and (= (:uid claims) (:profile-id token))
                   (= mcp-claims? mcp-token?))
          (cond-> (update token :perms db/decode-pgarray #{})
            ;; The profile state, read with the token: an MCP call of a
            ;; profile that turned MCP off is refused, and the command
            ;; reads the active and blocked flags from here.
            mcp-token?
            (as-> token
                  (let [state (profile-state pool (:profile-id token))]
                    (assoc token
                           :profile state
                           :mcp-enabled (mcp-enabled-state? state))))))))))

(defn- wrap-authz
  "Authenticate requests carrying an access token. Personal tokens need the
  `access-tokens` flag. MCP tokens are restricted to specific commands, so
  only RPC routes opt in (the RPC wrapper enforces those restrictions); they
  need either the `mcp` or the `access-tokens` flag."
  [handler {:keys [::db/pool ::allow-mcp]}]
  (let [personal-enabled? (contains? cf/flags :access-tokens)
        mcp-enabled?      (and allow-mcp
                               (or personal-enabled?
                                   (contains? cf/flags :mcp)))]
    (fn [request]
      (let [{:keys [type claims]} (get request ::http/auth-data)]
        (if (and (= :token type)
                 (if (= mcp-token-issuer (:iss claims))
                   mcp-enabled?
                   personal-enabled?))
          (let [{:keys [perms profile-id expires-at type mcp-enabled profile]}
                (some->> claims (get-token-data pool))
                token-id (get claims :tid)]
            (handler (cond-> request
                       (some? perms)
                       (assoc ::perms perms)

                       (some? profile)
                       (assoc ::profile profile)

                       (some? mcp-enabled)
                       (assoc ::mcp-enabled mcp-enabled)
                       (some? profile-id)
                       (assoc ::profile-id profile-id)
                       (some? expires-at)
                       (assoc ::expires-at expires-at)
                       (some? token-id)
                       (assoc ::id token-id)
                       (some? type)
                       (assoc ::type type))))

          (handler request))))))

(def authz
  {:name ::authz
   :compile (fn [& _]
              (when (or (contains? cf/flags :access-tokens)
                        (contains? cf/flags :mcp))
                wrap-authz))})
