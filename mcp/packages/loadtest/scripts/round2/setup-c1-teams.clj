;; Round 2 team setup for scenario C1 (team scale). Runs in the dev backend's nREPL
;; (see setup-c1-teams.sh). Uses existing profiles only: token lines 10k..10k+9 map to
;; the profiles mcpdev@example.com (line 0) and mcpagent<i>@example.com (lines 1..49).
;; Creates five teams "mcp-r2-c1-team-<k>" (k = 0..4), each with ten members, the first
;; one as owner, and one project "r2-c1" per team.
;; Idempotent: an owned team with the same name is reused, members and the project are
;; added only when missing. Reads and writes no token file and creates no token.
;; Output: /tmp/r2-c1-teams.json inside the container (ids and emails only) and a
;; RESULT>> line on stdout.
(ns r2.setup.c1-teams
  (:require [app.system] [app.db :as db]
            [app.config :as cf] [app.common.features :as cfeat]
            [app.rpc.commands.teams :as teams]
            [clojure.set :as set] [clojure.string :as str]))

(def ^:private group-size 10)
(def ^:private group-count 5)
(def ^:private project-name "r2-c1")

(defn- email-for [i]
  (if (zero? i) "mcpdev@example.com" (str "mcpagent" i "@example.com")))

(defn- team-features []
  (-> (cfeat/get-enabled-features cf/flags)
      (set/difference cfeat/frontend-only-features)
      (set/difference cfeat/no-team-inheritable-features)))

(defn- find-owned-team [conn team-name owner-id]
  (:id (db/exec-one! conn ["SELECT t.id FROM team AS t JOIN team_profile_rel AS tpr ON tpr.team_id = t.id WHERE t.name = ? AND tpr.profile_id = ? AND tpr.is_owner IS true AND t.deleted_at IS NULL"
                           team-name owner-id])))

(defn- find-project [conn team-id]
  (:id (db/exec-one! conn ["SELECT id FROM project WHERE team_id = ? AND name = ? AND deleted_at IS NULL"
                           team-id project-name])))

(defn- setup-group [cfg conn features profiles k]
  (let [members   (subvec profiles (* k group-size) (* (inc k) group-size))
        owner     (first members)
        team-name (str "mcp-r2-c1-team-" k)
        team-id   (or (find-owned-team conn team-name (:profile-id owner))
                      (:id (teams/create-team cfg {:profile-id (:profile-id owner)
                                                   :name team-name
                                                   :features features})))]
    (doseq [m (rest members)]
      (when-not (db/get* conn :team-profile-rel {:profile-id (:profile-id m) :team-id team-id})
        (teams/add-profile-to-team! cfg {:profile-id (:profile-id m) :team-id team-id
                                         :is-owner false :is-admin false :can-edit true}
                                    {})))
    (let [project-id (or (find-project conn team-id)
                         (let [project (teams/create-project conn {:team-id team-id :name project-name})]
                           (teams/create-project-role conn (:profile-id owner) (:id project) :owner)
                           (:id project)))]
      {:k         k
       :teamId    (str team-id)
       :projectId (str project-id)
       :ownerEmail (:email owner)
       :members   (mapv :email members)})))

(defn- run [cfg]
  (let [conn     (::db/conn cfg)
        ;; Lookup phase: every profile must exist before any write.
        profiles (mapv (fn [i]
                         (let [email (email-for i)
                               p     (db/get* conn :profile {:email email})]
                           (when-not p
                             (throw (ex-info (str "missing profile: " email) {})))
                           {:i i :email email :profile-id (:id p)}))
                       (range (* group-size group-count)))
        features (team-features)]
    (mapv #(setup-group cfg conn features profiles %) (range group-count))))

(defn- team->json [{:keys [k teamId projectId ownerEmail members]}]
  (str "{\"k\":" k
       ",\"teamId\":" (pr-str teamId)
       ",\"projectId\":" (pr-str projectId)
       ",\"ownerEmail\":" (pr-str ownerEmail)
       ",\"members\":[" (str/join "," (map pr-str members)) "]}"))

(let [result (db/tx-run! app.system/system run)
      json   (str "{\"teams\":[" (str/join "," (map team->json result)) "]}")]
  (spit "/tmp/r2-c1-teams.json" json)
  (println "RESULT>>" json))
