;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.render-wasm.upload-pool
  "Pool of web workers that decode shapes and encode WASM upload entries
  off the main thread.

  The workers speak a raw protocol: plain JS objects, never transit. Each
  request has `penpotUpload` set to true, an `op` and a `req` number. Every
  op except `release` gets one reply with the same `req`, or with an `error`
  string. Ops:
  - `config`: the font catalog, as a transit string with `:google?` and `:custom`.
  - `load`: decodes the shapes of a job and replies with each shape's structure.
  - `encode`: encodes the shapes of a job into one buffer and replies with the
    entries and the font table.
  - `release`: drops the shapes of a job. No reply.

  A worker that crashes, cannot read a message or does not reply in time is
  killed. The next `ensure-pool!` replaces it.

  `penpotUpload` also tells the transit worker messaging to skip these messages."
  (:require
   [app.common.logging :as log]
   [app.common.transit :as t]
   [app.config :as cf]
   [app.main.fonts :as fonts]
   [promesa.core :as p]))

(def ^:private idle-timeout-ms 60000)

;; Milliseconds a request of each op may wait for its reply.
(def ^:private request-timeout-ms
  {"load"   120000
   "encode" 30000
   "config" 10000})

(def ^:private initial-state
  {:workers  []
   :pending  {}
   :next-req 1
   :fonts-db nil
   :jobs     0
   :shutdown nil
   :dead     #{}})

(defonce ^:private state* (atom initial-state))

(defn available?
  "True when this browser can start the upload workers."
  []
  (and (exists? js/Worker) (some? cf/worker-uri)))

(defn pool-size
  "Number of upload workers: one less than the CPU cores, from 2 to 6."
  []
  (let [n (or (when (exists? js/navigator)
                (.-hardwareConcurrency js/navigator))
              4)]
    (-> n dec (max 2) (min 6))))

(defn- on-worker-message
  "Settles the pending request that a worker reply answers, and clears its
  timeout. Messages without `penpotUpload` are not ours and are ignored."
  [^js event]
  (let [data (.-data event)]
    (when (unchecked-get data "penpotUpload")
      (let [req   (unchecked-get data "req")
            entry (get-in @state* [:pending req])]
        (when (some? entry)
          (js/clearTimeout (:timer entry))
          (swap! state* update :pending dissoc req)
          (if-let [error (unchecked-get data "error")]
            ((:reject entry) (ex-info "upload worker error" {:hint error}))
            ((:resolve entry) data)))))))

(defn- reject-pending!
  "Rejects every pending request sent to worker `idx` with `cause`."
  [idx cause]
  (let [mine (filter #(= idx (:worker (val %))) (:pending @state*))]
    (swap! state* update :pending
           #(reduce (fn [pending [req _]] (dissoc pending req)) % mine))
    (doseq [[_ entry] mine]
      (js/clearTimeout (:timer entry))
      ((:reject entry) cause))))

(defn- kill-worker!
  "Marks worker `idx` dead, rejects its pending requests with `cause` and
  terminates it. Does nothing when `worker` is no longer the worker at `idx`."
  [idx ^js worker cause]
  (when (identical? worker (get (:workers @state*) idx))
    (swap! state* update :dead conj idx)
    (reject-pending! idx cause)
    (.terminate worker)))

(defn- create-worker
  "Starts upload worker `idx` with its message and error listeners."
  [idx]
  (let [worker (js/Worker. cf/worker-uri)]
    (.addEventListener worker "message" on-worker-message)
    (.addEventListener worker "error"
                       (fn [^js event]
                         (log/error :hint "upload worker crashed" :idx idx)
                         (kill-worker! idx worker
                                       (ex-info "upload worker failed"
                                                {:hint (.-message event)}))))
    (.addEventListener worker "messageerror"
                       (fn [_]
                         (log/error :hint "upload worker message error" :idx idx)
                         (kill-worker! idx worker
                                       (ex-info "upload worker message error"
                                                {:hint "upload worker message error"}))))
    worker))

(defn- cancel-shutdown!
  "Cancels the pending idle shutdown, if there is one."
  []
  (when-let [id (:shutdown @state*)]
    (js/clearTimeout id)
    (swap! state* assoc :shutdown nil)))

(defn- shutdown!
  "Terminates every worker, rejects the requests still pending and resets the
  pool to its initial state. The request counter is kept, so that request
  numbers stay unique."
  []
  (let [{:keys [workers pending next-req]} @state*]
    (reset! state* (assoc initial-state :next-req next-req))
    (doseq [worker workers]
      (.terminate worker))
    (doseq [[_ entry] pending]
      (js/clearTimeout (:timer entry))
      ((:reject entry) (ex-info "upload pool shut down" {})))))

(defn- schedule-shutdown!
  "Terminates the workers after the idle timeout, unless a job starts first."
  []
  (cancel-shutdown!)
  (swap! state* assoc :shutdown (js/setTimeout shutdown! idle-timeout-ms)))

(defn ensure-pool!
  "Starts the workers when there are none, replaces the dead ones, cancels a
  pending shutdown and returns the workers. A replaced worker has no font
  database, so the database is sent again to every worker. Call only when
  `available?` is true."
  []
  (cancel-shutdown!)
  (let [{:keys [workers dead]} @state*]
    (cond
      (empty? workers)
      (let [workers (mapv create-worker (range (pool-size)))]
        (swap! state* assoc :workers workers)
        workers)

      (seq dead)
      (let [workers (reduce (fn [workers idx]
                              (assoc workers idx (create-worker idx)))
                            workers
                            dead)]
        (swap! state* assoc :workers workers :dead #{} :fonts-db nil)
        workers)

      :else
      workers)))

(defn worker-count
  "Number of running upload workers."
  []
  (count (:workers @state*)))

(defn request!
  "Posts `msg` to worker `idx` and returns a promise of its reply. `transfer`
  is the optional list of buffers to move to the worker. Sets `penpotUpload`
  and `req` on `msg`. The promise rejects at once when the worker is dead or
  missing. When no reply comes in time for the op, the worker is killed and
  the promise rejects."
  [idx ^js msg transfer]
  (p/create
   (fn [resolve reject]
     (let [{:keys [workers dead]} @state*
           worker (get workers idx)]
       (if (or (nil? worker) (contains? dead idx))
         (reject (ex-info "upload worker is not running" {:idx idx}))
         (let [req   (:next-req @state*)
               timer (js/setTimeout
                      (fn []
                        (when (contains? (:pending @state*) req)
                          (kill-worker! idx worker
                                        (ex-info "upload worker timed out"
                                                 {:hint "upload worker timed out"}))))
                      (get request-timeout-ms (unchecked-get msg "op") 30000))]
           (swap! state* (fn [s]
                           (-> s
                               (update :next-req inc)
                               (assoc-in [:pending req] {:resolve resolve
                                                         :reject  reject
                                                         :worker  idx
                                                         :timer   timer}))))
           (unchecked-set msg "penpotUpload" true)
           (unchecked-set msg "req" req)
           (try
             (.postMessage worker msg (or transfer #js []))
             (catch :default cause
               (js/clearTimeout timer)
               (swap! state* update :pending dissoc req)
               (reject cause)))))))))

(defn configure-fonts!
  "Sends the font database to every worker when it changed since the last
  send. Returns a promise that settles when the workers have it."
  []
  (let [db      @fonts/fontsdb
        ;; Mid-job, a dead worker is not replaced here: the new one would
        ;; not hold the job's shapes.
        workers (let [workers (:workers @state*)]
                  (if (seq workers) workers (ensure-pool!)))]
    (if (identical? db (:fonts-db @state*))
      (p/resolved nil)
      (let [payload (t/encode-str {:google? (contains? cf/flags :google-fonts-provider)
                                   :custom  (filterv #(= :custom (:backend %))
                                                     (vals db))})]
        (swap! state* assoc :fonts-db db)
        (p/all (mapv (fn [idx]
                       (request! idx #js {:op "config" :fonts payload} nil))
                     (range (count workers))))))))

(defn release!
  "Tells every worker to drop the shapes of `job`. No reply is expected."
  [job]
  (doseq [worker (:workers @state*)]
    (.postMessage worker #js {:penpotUpload true :op "release" :job job})))

(defn job-started!
  "Marks a job as running. Cancels any pending shutdown."
  []
  (cancel-shutdown!)
  (swap! state* update :jobs inc))

(defn job-ended!
  "Marks a job as finished. When no job runs any more, the workers shut down
  after the idle timeout."
  []
  (let [n (max 0 (dec (:jobs @state*)))]
    (swap! state* assoc :jobs n)
    (when (zero? n)
      (schedule-shutdown!))))

(defn prewarm!
  "Starts the pool ahead of the first job. The workers shut down after the
  idle timeout when no job starts."
  []
  (when (available?)
    (ensure-pool!)
    (when (zero? (:jobs @state*))
      (schedule-shutdown!))))
