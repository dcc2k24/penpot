;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-config-test
  "Checks that the MCP configuration and the caches agree with the code:
  every concurrency id a command declares has a limit, the MCP read
  buckets refill under steady use, MCP token calls count under their own
  key, and a weighted cache evicts by weight."
  (:require
   [app.common.files.changes :as cpc]
   [app.main :as main]
   [app.rpc :as-alias rpc]
   [app.rpc.rlimit :as rlimit]
   [app.util.cache :as cache]
   [clojure.edn :as edn]
   [clojure.set :as set]
   [clojure.test :as t]))

(def ^:private mcp-command-files
  "The source files that declare MCP commands."
  ["src/app/rpc/commands/mcp.clj"
   "src/app/rpc/commands/mcp_fonts.clj"
   "src/app/rpc/commands/mcp_lint.clj"
   "src/app/rpc/commands/mcp_prototype.clj"
   "src/app/rpc/commands/mcp_subtree.clj"
   "src/app/rpc/commands/mcp_write.clj"])

(defn- declared-climit-ids
  "The climit ids that the command metadata of `path` declares. Each
  `::climit/id` form runs up to the next metadata key."
  [path]
  (->> (re-seq #"(?s)::climit/id(.*?)\n\s*::" (slurp path))
       (map second)
       (mapcat #(re-seq #":(mcp-[a-z-]+/[a-z0-9-]+)" %))
       (map (comp keyword second))
       (distinct)
       (sort)))

(t/deftest every-declared-mcp-climit-id-has-an-entry
  (let [limits (edn/read-string (slurp "resources/climit.edn"))
        ids    (mapcat declared-climit-ids mcp-command-files)]
    (t/is (seq ids) "the scan finds the MCP ids")
    (doseq [id ids]
      (t/is (contains? limits id)
            (str id " is declared by a command but has no entry in climit.edn")))))

(t/deftest mcp-read-buckets-refill-under-steady-use
  ;; The script refills whole tokens each second. A bucket refills
  ;; under steady use when its rate, per second, is at least one.
  (doseq [[opts name] [["1200/600/1m" :mcp-read]
                       ["600/300/1m" :mcp-write]]]
    (let [limit    (rlimit/parse-limit [name :bucket opts])
          seconds  (.getSeconds ^java.time.Duration (::rlimit/interval limit))
          per-sec  (/ (double (::rlimit/rate limit)) seconds)]
      (t/is (>= per-sec 1.0) (str opts " refills at least one token per second"))))
  ;; The adapter lets 10 requests per second through, so the read bucket
  ;; refills at that rate: the backend never refuses a call the adapter allows.
  (let [limit   (rlimit/parse-limit [:mcp-read :bucket "1200/600/1m"])
        seconds (.getSeconds ^java.time.Duration (::rlimit/interval limit))]
    (t/is (= 10.0 (/ (double (::rlimit/rate limit)) seconds)))))

(t/deftest mcp-token-calls-count-under-their-own-key
  (let [profile-id (java.util.UUID/randomUUID)]
    (t/is (= (str profile-id ".mcp")
             (#'rlimit/get-uid {::rpc/profile-id profile-id
                                ::rpc/token-type "mcp"})))
    (t/is (= profile-id
             (#'rlimit/get-uid {::rpc/profile-id profile-id})))
    (t/is (= profile-id
             (#'rlimit/get-uid {::rpc/profile-id profile-id
                                ::rpc/token-type "session"})))))

(t/deftest weighted-cache-evicts-by-weight
  (let [c (cache/create :max-weight 10 :weigher #(count %))]
    (doseq [i (range 5)]
      (cache/put c i (vec (range 3))))
    (cache/cleanup c)
    (let [kept (filter #(some? (cache/get c %)) (range 5))]
      (t/is (<= (* 3 (count kept)) 10) "the kept entries weigh at most the bound")
      (t/is (< (count kept) 5) "some entries were evicted"))))

(t/deftest weighted-cache-keeps-what-fits
  (let [c (cache/create :max-weight 10 :weigher #(count %))]
    (cache/put c :small (vec (range 4)))
    (cache/cleanup c)
    (t/is (= [0 1 2 3] (cache/get c :small)))))

(t/deftest cache-put-replaces-an-entry
  (let [c (cache/create :max-size 10)]
    (cache/put c :k 1)
    (cache/put c :k 2)
    (t/is (= 2 (cache/get c :k)))))

(t/deftest mcp-apply-by-profile-has-one-permit-and-a-queue
  ;; The write path also takes update-file/by-profile (one permit), so a
  ;; second apply permit could only ever wait. One permit, a short queue.
  (let [limits (edn/read-string (slurp "resources/climit.edn"))]
    (t/is (= {:permits 1 :queue 5 :timeout 60000}
             (get limits :mcp-apply/by-profile)))))

(t/deftest write-commands-declare-the-team-limit
  (let [src    (slurp "src/app/rpc/commands/mcp_write.clj")
        limits (edn/read-string (slurp "resources/climit.edn"))]
    ;; The three write commands share the per-team ceiling.
    (t/is (= 3 (count (re-seq #"\[:mcp-apply/by-team team-key\]" src))))
    (t/is (= {:permits 4 :queue 50 :timeout 60000}
             (select-keys (get limits :mcp-apply/by-team)
                          [:permits :queue :timeout])))))

(t/deftest write-commands-take-the-team-limit-last
  ;; `climit/wrap` takes the first declared limit innermost, so the team
  ;; lookup must be the last declared: it runs before any permit is held.
  (let [src     (slurp "src/app/rpc/commands/mcp_write.clj")
        vectors (re-seq #"(?s)::climit/id \[(.*?)\]\]" src)]
    (t/is (= 3 (count vectors)))
    (doseq [[_ body] vectors]
      (t/is (= "mcp-apply/by-team" (second (last (re-seq #":(mcp-[a-z/-]+)" body))))))))

(defn- mcp-codes-raised-from
  "The `:code :mcp-...` literals of the source at `path`, from the first
  occurrence of `marker` on."
  [path marker]
  (let [src  (slurp path)
        from (.indexOf ^String src ^String marker)]
    (assert (<= 0 from) (str marker " is not in " path))
    (into #{} (map second) (re-seq #":code :(mcp-[a-z-]+)" (subs src from)))))

(t/deftest change-type-labels-are-the-processor-methods
  (let [labels (set main/mcp-change-types)]
    (t/is (> (count labels) 40))
    (t/is (= labels (set (map name (keys (methods cpc/process-change))))))))

(t/deftest recorded-mcp-error-codes-are-listed
  ;; The codes the tools raise after `run-tool` (in `mcp.clj`) and the
  ;; codes of `mcp_write.clj`, which all run inside a tool, must appear in
  ;; the list the metrics start from, or their first error is invisible
  ;; to `rate()`. Codes raised before `run-tool` are not recorded and are
  ;; not listed.
  (let [listed (set main/mcp-error-codes)
        raised (set/union
                (mcp-codes-raised-from "src/app/rpc/commands/mcp.clj" "(defn run-tool")
                (mcp-codes-raised-from "src/app/rpc/commands/mcp_write.clj" "(ns ")
                (mcp-codes-raised-from "src/app/rpc/commands/mcp_fonts.clj" "(ns ")
                (mcp-codes-raised-from "src/app/rpc/commands/mcp_lint.clj" "(ns ")
                (mcp-codes-raised-from "src/app/rpc/commands/mcp_prototype.clj" "(ns ")
                (mcp-codes-raised-from "src/app/rpc/commands/mcp_subtree.clj" "(ns "))]
    (t/is (contains? raised "mcp-invalid-change"))
    (doseq [code raised]
      (t/is (contains? listed code) (str code " is raised but not in mcp-error-codes")))))
