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
   [app.rpc :as-alias rpc]
   [app.rpc.rlimit :as rlimit]
   [app.util.cache :as cache]
   [clojure.edn :as edn]
   [clojure.test :as t]))

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
        ids    (concat (declared-climit-ids "src/app/rpc/commands/mcp.clj")
                       (declared-climit-ids "src/app/rpc/commands/mcp_write.clj"))]
    (t/is (seq ids) "the scan finds the MCP ids")
    (doseq [id ids]
      (t/is (contains? limits id)
            (str id " is declared by a command but has no entry in climit.edn")))))

(t/deftest mcp-read-buckets-refill-under-steady-use
  ;; The script refills whole tokens each second. A bucket refills
  ;; under steady use when its rate, per second, is at least one.
  (doseq [[opts name] [["1200/600/1m" :mcp-read]
                       ["120/60/1m" :mcp-write]]]
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
