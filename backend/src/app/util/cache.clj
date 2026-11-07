;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.util.cache
  "In-memory cache backed by Caffeine"
  (:refer-clojure :exclude [get])
  (:require
   [app.common.schema :as sm]
   [app.common.time :as ct]
   [promesa.exec :as px])
  (:import
   com.github.benmanes.caffeine.cache.Cache
   com.github.benmanes.caffeine.cache.Caffeine
   com.github.benmanes.caffeine.cache.RemovalListener
   com.github.benmanes.caffeine.cache.stats.CacheStats
   com.github.benmanes.caffeine.cache.Weigher
   java.time.Duration
   java.util.concurrent.Executor
   java.util.function.Function))

(set! *warn-on-reflection* true)

(defprotocol ICache
  (get [_ k] [_ k load-fn] "get cache entry")
  (put [_ k v] "store value v under k, replacing any entry")
  (invalidate [_] [_ k] "invalidate cache")
  (invalidate-if [_ pred] "invalidate all entries whose value satisfies pred")
  (cleanup [_] "run pending evictions now; Caffeine runs them off the caller's thread"))

(defprotocol ICacheStats
  (stats [_] "get stats"))

(defn- create-listener
  [f]
  (reify RemovalListener
    (onRemoval [_ key val cause]
      (when val
        (f key val cause)))))

(defn- get-stats
  [^Cache cache]
  (let [^CacheStats stats (.stats cache)]
    {:hit-rate (.hitRate stats)
     :hit-count (.hitCount stats)
     :req-count (.requestCount stats)
     :miss-count (.missCount stats)
     :miss-rate  (.missRate stats)}))

(defn- create-weigher
  [f]
  (reify Weigher
    (weigh [_ _ v]
      (int (f v)))))

(defn create
  "Build an in-memory cache. Loads run synchronously on the calling
  thread, so when a load fn throws or returns nil the entry is not
  stored — concurrent loads for the same key still deduplicate.

  The cache is bounded by entry count (`max-size`), or by weight when
  both `weigher` and `max-weight` are given: `weigher` takes a value and
  returns its weight, and the cache keeps the total under `max-weight`.
  Weight is for values whose size varies, such as pages of shapes."
  [& {:keys [executor on-remove max-size max-weight weigher keepalive expire]}]
  (let [cache (as-> (Caffeine/newBuilder) builder
                (if (fn? on-remove) (.removalListener builder (create-listener on-remove)) builder)
                (if executor  (.executor builder ^Executor (px/resolve-executor executor)) builder)
                (if keepalive (.expireAfterAccess builder ^Duration (ct/duration keepalive)) builder)
                (if expire    (.expireAfterWrite  builder ^Duration (ct/duration expire)) builder)
                (if (and (fn? weigher) (int? max-weight))
                  (doto builder
                    (.weigher (create-weigher weigher))
                    (.maximumWeight (long max-weight)))
                  (if (int? max-size) (.maximumSize builder (long max-size)) builder))
                (.recordStats builder)
                (.build builder))]
    (reify
      ICache
      (get [_ k]
        (.getIfPresent ^Cache cache ^Object k))
      (put [_ k v]
        (.put ^Cache cache ^Object k ^Object v))
      (get [_ k load-fn]
        (.get ^Cache cache
              ^Object k
              ^Function (reify Function
                          (apply [_ k]
                            (load-fn k)))))
      (invalidate [_]
        (.invalidateAll ^Cache cache))
      (invalidate [_ k]
        (.invalidate ^Cache cache ^Object k))
      (invalidate-if [_ pred]
        (doseq [[k v] (.asMap ^Cache cache)]
          (when (pred v)
            (.invalidate ^Cache cache ^Object k))))
      (cleanup [_]
        (.cleanUp ^Cache cache))

      ICacheStats
      (stats [_]
        (get-stats cache)))))

(defn cache?
  [o]
  (satisfies? ICache o))

(sm/register!
 {:type ::cache
  :pred cache?
  :type-properties
  {:title "cache instance"}})
