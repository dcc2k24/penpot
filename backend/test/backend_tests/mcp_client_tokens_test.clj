;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.mcp-client-tokens-test
  "One MCP token per OAuth client: approval, narrowing, revocation, and the
  hand-made token kept apart from the client tokens."
  (:require
   [app.common.time :as ct]
   [app.config :as cf]
   [app.db :as db]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.access-token :as access-token]
   [app.rpc.commands.profile :as profile]
   [backend-tests.helpers :as th]
   [clojure.string :as str]
   [clojure.test :as t]))

(t/use-fixtures :once th/state-init)
(t/use-fixtures :each th/database-reset
  (fn [run]
    (binding [cf/config (assoc cf/config :tenant (str (java.util.UUID/randomUUID)))]
      (run))))

;; --- HELPERS

(defn- perms-of
  [row]
  (db/decode-pgarray (:perms row) []))

(defn- mcp-scope-perms
  [row]
  (vec (sort (filter #(str/starts-with? % "mcp:") (perms-of row)))))

(defn- rows
  "The MCP token rows of `profile`, hand-made and client ones."
  [profile]
  (db/query th/*pool* :access-token {:profile-id (:id profile) :type "mcp"}))

(defn- client-rows
  [profile]
  (filter :client-id (rows profile)))

(defn- client-row
  [profile client-id]
  (first (filter #(= client-id (:client-id %)) (rows profile))))

(defn- grant!
  [profile client-id client-name scopes]
  (db/tx-run! th/*system* access-token/grant-client-mcp-scopes
              (:id profile) client-id client-name scopes))

(defn- hand-made-row
  [profile]
  (first (filter #(nil? (:client-id %)) (rows profile))))

(defn- ensure-hand-made!
  "A hand-made MCP token, as the settings page makes it."
  [profile]
  (db/tx-run! th/*system* access-token/create-access-token (:id profile) "MCP" nil "mcp")
  (hand-made-row profile))

;; --- MIGRATION

(t/deftest migration-adds-client-columns-and-index
  (t/is (empty? (db/exec! th/*pool* ["SELECT client_id, client_name FROM access_token LIMIT 0"])))
  (t/is (= 1 (count (db/exec! th/*pool*
                              ["SELECT 1 FROM pg_indexes
                                 WHERE tablename = 'access_token'
                                   AND indexname = 'access_token_profile_id_client_id_uidx'"])))))

;; --- APPROVAL

(t/deftest approval-creates-a-client-row-with-the-requested-scopes
  (let [profile (th/create-profile* 1 {:is-active true})
        _       (grant! profile "client-a" "Client A" ["mcp:read" "mcp:write"])
        row     (client-row profile "client-a")]
    (t/is (= "client-a" (:client-id row)))
    (t/is (= "Client A" (:client-name row)))
    (t/is (= ["mcp:read" "mcp:write"] (mcp-scope-perms row)))
    ;; The configured MCP lifetime applies to the client token.
    (t/is (some? (:expires-at row)))
    (t/is (ct/is-after? (ct/in-future (ct/duration {:days 91})) (:expires-at row)))))

(t/deftest second-client-approval-does-not-change-the-first
  (let [profile (th/create-profile* 1 {:is-active true})
        _       (grant! profile "client-a" "A" ["mcp:read" "mcp:write"])
        before  (client-row profile "client-a")
        _       (grant! profile "client-b" "B" ["mcp:read"])
        after   (client-row profile "client-a")]
    (t/is (= (:id before) (:id after)))
    (t/is (= ["mcp:read" "mcp:write"] (mcp-scope-perms after)))
    (t/is (= ["mcp:read"] (mcp-scope-perms (client-row profile "client-b"))))
    (t/is (= 2 (count (client-rows profile))))))

(t/deftest re-approval-narrows-the-clients-token
  (let [profile (th/create-profile* 1 {:is-active true})
        _       (grant! profile "client-a" "A" ["mcp:read" "mcp:write" "mcp:manage"])
        _       (grant! profile "client-a" "A" ["mcp:read"])
        row     (client-row profile "client-a")]
    (t/is (= ["mcp:read"] (mcp-scope-perms row)))
    ;; One row per client: the re-approval replaced the earlier one.
    (t/is (= 1 (count (client-rows profile))))))

;; --- REVOCATION

(t/deftest revoking-one-client-leaves-the-others
  (let [profile (th/create-profile* 1 {:is-active true})
        _       (grant! profile "client-a" "A" ["mcp:read"])
        _       (grant! profile "client-b" "B" ["mcp:read" "mcp:write"])
        row-a   (client-row profile "client-a")
        out     (th/command! {::th/type :delete-access-token
                              ::rpc/profile-id (:id profile)
                              :id (:id row-a)})]
    (t/is (nil? (:error out)))
    (t/is (nil? (client-row profile "client-a")))
    (t/is (= ["mcp:read" "mcp:write"] (mcp-scope-perms (client-row profile "client-b"))))))

;; --- HAND-MADE TOKEN

(t/deftest hand-made-token-is-untouched-by-client-approvals
  (let [profile (th/create-profile* 1 {:is-active true})
        hand    (ensure-hand-made! profile)
        _       (grant! profile "client-a" "A" ["mcp:read" "mcp:write"])
        after   (hand-made-row profile)]
    (t/is (= (:id hand) (:id after)))
    (t/is (= (perms-of hand) (perms-of after)))
    (t/is (nil? (:client-id after)))))

(t/deftest regenerating-the-hand-made-token-keeps-the-client-tokens
  (let [profile (th/create-profile* 1 {:is-active true})
        _       (ensure-hand-made! profile)
        _       (grant! profile "client-a" "A" ["mcp:read"])
        _       (grant! profile "client-b" "B" ["mcp:read" "mcp:write"])
        old     (hand-made-row profile)
        _       (db/tx-run! th/*system* access-token/create-access-token
                            (:id profile) "MCP" nil "mcp")
        new     (hand-made-row profile)]
    (t/is (not= (:id old) (:id new)))
    (t/is (= 2 (count (client-rows profile))))
    (t/is (= ["mcp:read"] (mcp-scope-perms (client-row profile "client-a"))))
    (t/is (= ["mcp:read" "mcp:write"] (mcp-scope-perms (client-row profile "client-b"))))))

;; --- SETTINGS LISTING

(t/deftest settings-list-shows-each-client-token-with-its-name-and-scopes
  (let [profile (th/create-profile* 1 {:is-active true})
        _       (ensure-hand-made! profile)
        _       (grant! profile "client-a" "Client A" ["mcp:read" "mcp:write"])
        out     (th/command! {::th/type :get-access-tokens
                              ::rpc/profile-id (:id profile)})
        listed  (filter :client-id (:result out))]
    (t/is (nil? (:error out)))
    (t/is (= 1 (count listed)))
    (t/is (= "Client A" (:client-name (first listed))))
    (t/is (= ["mcp:read" "mcp:write"] (:scopes (first listed))))
    (t/is (some? (:expires-at (first listed))))
    ;; The client secret is never listed.
    (t/is (not (contains? (first listed) :token)))))

(t/deftest client-id-is-unique-per-profile-and-bounded
  (let [profile (th/create-profile* 1 {:is-active true})
        _       (grant! profile "client-a" "A" ["mcp:read"])
        dup     (try (db/exec! th/*pool*
                               ["INSERT INTO access_token (id, name, token, type, profile_id,
                                                           created_at, updated_at, perms, client_id)
                                 VALUES (gen_random_uuid(), 'x', 'x', 'mcp', ?, now(), now(),
                                         ARRAY[]::text[], 'client-a')"
                                (:id profile)])
                     :inserted
                     (catch org.postgresql.util.PSQLException _ :duplicate))
        long-id (try (grant! profile (apply str (repeat 513 "x")) "B" ["mcp:read"])
                     :stored
                     (catch Exception _ :too-long))]
    (t/is (= :duplicate dup))
    (t/is (= :too-long long-id))))

(t/deftest approval-enables-mcp-for-the-profile
  (let [profile (th/create-profile* 1 {:is-active true})
        _       (db/tx-run! th/*system* profile/update-profile-props (:id profile)
                            {:mcp-enabled false})
        _       (grant! profile "client-a" "A" ["mcp:read"])
        props   (-> (th/db-get :profile {:id (:id profile)})
                    :props db/decode-transit-pgobject)]
    (t/is (true? (:mcp-enabled props)))))

(t/deftest client-tokens-are-capped-per-profile
  (let [profile (th/create-profile* 1 {:is-active true})]
    (doseq [i (range access-token/max-client-mcp-tokens)]
      (grant! profile (str "client-" i) "C" ["mcp:read"]))
    ;; A re-approval of a client already holding a token does not count again.
    (t/is (some? (grant! profile "client-0" "C" ["mcp:read"])))
    (let [refused (try (grant! profile "client-new" "N" ["mcp:read"])
                       :stored
                       (catch clojure.lang.ExceptionInfo cause
                         (:code (ex-data cause))))]
      (t/is (= :mcp-client-limit refused))
      (t/is (nil? (client-row profile "client-new")))
      (t/is (= access-token/max-client-mcp-tokens (count (client-rows profile)))))))
