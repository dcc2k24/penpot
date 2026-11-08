;; Dev-stack setup for the adversarial suite. Runs in the dev backend's nREPL
;; (see setup-dev.sh). Creates five throwaway profiles and one MCP token each,
;; writes the tokens to /tmp/adv-tokens.edn inside the backend container and
;; prints only their ids and lengths. Re-running replaces the tokens.
;;
;;   adv-read      member of the team, token with no mcp:* perm (= mcp:read)
;;   adv-off       member, all scopes, profile prop mcp-enabled = false
;;   adv-exp       member, all scopes, token expired 1 s after creation
;;   adv-revoked   member, all scopes, token row deleted after creation
;;   adv-outsider  not a member of the team, all scopes, own team only
(ns adv.setup
  (:require [app.system] [app.db :as db] [app.common.uuid :as uuid] [app.common.time :as ct]
            [app.rpc.commands.auth :as auth] [app.rpc.commands.teams :as teams]
            [app.rpc.commands.access-token :as atok] [app.rpc.commands.profile :as profile]
            [clojure.string :as str]))
(println "RESULT>>" (pr-str
 (let [cfg     app.system/system
       team-id (uuid/uuid "@TEAM_ID@")
       all     ["mcp:read" "mcp:write" "mcp:manage" "mcp:delete"]
       specs   [{:k :read :email "adv-read@example.com" :member true :perms []}
                {:k :off :email "adv-off@example.com" :member true :perms all}
                {:k :exp :email "adv-exp@example.com" :member true :perms all :expiration (ct/duration {:seconds 1})}
                {:k :revoked :email "adv-revoked@example.com" :member true :perms all}
                {:k :outsider :email "adv-outsider@example.com" :member false :perms all}]
       rows    (db/tx-run! cfg
                 (fn [cfg]
                   (let [conn (::db/conn cfg)]
                     (vec (for [{:keys [k email member perms expiration]} specs]
                            (let [p   (or (db/get* conn :profile {:email email})
                                          (let [p (auth/create-profile cfg {:email email :fullname (str "Adversary " (name k)) :is-active true :password "!"})]
                                            (auth/create-profile-rels cfg p)))
                                  _   (when (and member (not (db/get* conn :team-profile-rel {:profile-id (:id p) :team-id team-id})))
                                        (teams/add-profile-to-team! cfg {:profile-id (:id p) :team-id team-id :is-owner false :is-admin false :can-edit true} {}))
                                  tok (atok/create-access-token cfg (:id p) (str "adv-" (name k)) expiration "mcp")]
                              (db/exec-one! conn ["UPDATE access_token SET perms = ? WHERE id = ?" (db/create-array conn "text" perms) (:id tok)])
                              {:k k :profile-id (:id p) :token-id (:id tok) :token (:token tok)
                               :default-team-id (:default-team-id p)}))))))
       by-k    (into {} (map (juxt :k identity)) rows)]
   (db/tx-run! cfg profile/update-profile-props (get-in by-k [:off :profile-id]) {:mcp-enabled false})
   (db/tx-run! cfg profile/update-profile-props (get-in by-k [:read :profile-id]) {:mcp-enabled true})
   (db/tx-run! cfg (fn [{:keys [::db/conn]}] (db/delete! conn :access-token {:id (get-in by-k [:revoked :token-id])})))
   (spit "/tmp/adv-tokens.edn" (pr-str (into {} (map (fn [r] [(:k r) (:token r)])) rows)))
   (spit "/tmp/adv-ids.json" (str "{" (str/join "," (map (fn [r] (str "\"" (name (:k r)) "ProfileId\":\"" (:profile-id r) "\"")) rows)) "}"))
   (map (fn [r] [(:k r) (str (:profile-id r)) (count (:token r))]) rows))))
