;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.common.types.objects-map
  "Implements a specialized map-like data structure for store an UUID =>
  OBJECT mappings. The main purpose of this data structure is be able
  to serialize it on fressian as byte-array and have the ability to
  decode each field separately without the need to decode the whole
  map from the byte-array.

  It works transparently, so no additional dynamic vars are needed.  It
  only works by reference equality and the hash-code is calculated
  properly from each value."

  (:require
   #?(:clj [app.common.fressian :as fres])
   #?(:clj [clojure.data.json :as json])
   #?(:cljs [app.common.uuid :as uuid])
   [app.common.transit :as t]
   [clojure.core :as c]
   [clojure.core.protocols :as cp])
  #?(:clj
     (:import
      clojure.lang.Murmur3
      clojure.lang.RT
      java.util.Iterator)))

#?(:clj (set! *warn-on-reflection* true))

(declare create)
(declare ^:private do-compact)

(defprotocol IObjectsMap
  (^:no-doc compact [this])
  (^:no-doc get-data [this] "retrieve internal data")
  (^:no-doc -raw-data [this] "the internal id -> encoded value map, without compacting")
  (^:no-doc -hash-for-key [this key] "retrieve a hash for a key"))

#?(:cljs
   (deftype ObjectsMapEntry [key omap]
     c/IMapEntry
     (-key [_] key)
     (-val [_] (get omap key))

     c/IHash
     (-hash [this]
       (hash [key (c/-val this)]))

     c/IEquiv
     (-equiv [this other]
       (cond
         (c/map-entry? other)
         (and (= key (c/-key other))
              (= (c/-val this) (c/-val other)))

         (sequential? other)
         (and (= 2 (count other))
              (= key (nth other 0))
              (= (c/-val this) (nth other 1)))

         :else
         false))

     c/ISequential
     c/ISeqable
     (-seq [this]
       (cons key (lazy-seq (cons (c/-val this) nil))))

     c/ICounted
     (-count [_] 2)

     c/IIndexed
     (-nth [node n]
       (cond (== n 0) key
             (== n 1) (c/-val node)
             :else    (throw (js/Error. "Index out of bounds"))))

     (-nth [node n not-found]
       (cond (== n 0) key
             (== n 1) (c/-val node)
             :else    not-found))

     ;; A plain map's conj takes only vectors from a seq, so the entry is
     ;; a vector, as cljs.core/MapEntry is
     c/IVector
     (-assoc-n [node n v]
       (c/-assoc-n [key (c/-val node)] n v))

     c/ILookup
     (-lookup [node k]
       (c/-nth node k nil))
     (-lookup [node k not-found]
       (c/-nth node k not-found))

     c/IFn
     (-invoke [node k]
       (c/-nth node k))

     (-invoke [node k not-found]
       (c/-nth node k not-found))

     c/IPrintWithWriter
     (-pr-writer [this writer opts]
       (c/pr-sequential-writer
        writer
        (fn [item w _]
          (c/-write w (pr-str item)))
        "[" ", " "]"
        opts
        this)))

   :clj
   (deftype ObjectsMapEntry [key omap]
     clojure.lang.IMapEntry
     (key [_] key)
     (getKey [_] key)

     (val [_]
       (get omap key))
     (getValue [_]
       (get omap key))

     clojure.lang.Indexed
     (nth [node n]
       (cond
         (== n 0) key
         (== n 1) (val node)
         :else    (throw (IllegalArgumentException. "Index out of bounds"))))

     (nth [node n not-found]
       (cond
         (== n 0) key
         (== n 1) (val node)
         :else    not-found))

     clojure.lang.Sequential

     clojure.lang.IPersistentCollection
     (empty [_] [])
     (count [_] 2)
     (seq [this]
       (cons key (lazy-seq (cons (val this) nil))))
     (cons [this item]
       (conj [key (val this)] item))
     (equiv [this other]
       (cond
         (map-entry? other)
         (and (= key (clojure.core/key other))
              (= (val this) (clojure.core/val other)))

         (sequential? other)
         (and (= 2 (count other))
              (= key (nth other 0))
              (= (val this) (nth other 1)))

         :else
         false))

     clojure.lang.IHashEq
     (hasheq [this]
       (Murmur3/hashOrdered [key (val this)]))

     Object
     (equals [this other]
       (= this other))
     (hashCode [this]
       (unchecked-int
        (+ (* 31 (+ 31 (java.util.Objects/hashCode key)))
           (java.util.Objects/hashCode (val this)))))))

#?(:cljs
   (deftype ObjectMapIterator [iterator omap]
     Object
     (hasNext [_]
       (.hasNext ^js iterator))

     (next [_]
       (let [entry (.next iterator)]
         (ObjectsMapEntry. (key entry) omap)))

     (remove [_]
       (js/Error. "Unsupported operation")))

   :clj
   (deftype ObjectsMapIterator [^Iterator iterator omap]
     Iterator
     (hasNext [_]
       (.hasNext iterator))

     (next [_]
       (let [entry (.next iterator)]
         (ObjectsMapEntry. (key entry) omap)))))

#?(:cljs
   (deftype ObjectsMap [metadata cache
                        ^:mutable data
                        ^:mutable modified
                        ^:mutable hash]
     Object
     (toString [this]
       (pr-str* this))
     (equiv [this other]
       (c/-equiv this other))
     (keys [this]
       (c/es6-iterator (keys this)))
     (entries [this]
       (c/es6-entries-iterator (seq this)))
     (values [this]
       (es6-iterator (vals this)))
     (has [this k]
       (c/contains? this k))
     (get [this k not-found]
       (c/-lookup this k not-found))
     (forEach [this f]
       (run! (fn [[k v]] (f v k)) this))

     cp/Datafiable
     (datafy [_]
       {:data data
        :cache cache
        :modified modified
        :hash hash})

     IObjectsMap
     (compact [this]
       (when modified
         (do-compact data cache
                     (fn [data']
                       (set! (.-modified this) false)
                       (set! (.-data this) data'))))
       this)

     (get-data [this]
       (compact this)
       data)

     (-raw-data [_]
       data)

     (-hash-for-key [this key]
       (if (c/-contains-key? cache key)
         (c/-hash (c/-lookup cache key))
         (c/-hash (c/-lookup this key))))

     c/IWithMeta
     (-with-meta [this new-meta]
       (if (identical? new-meta metadata)
         this
         (ObjectsMap. new-meta
                      cache
                      data
                      modified
                      hash)))

     c/IMeta
     (-meta [_] metadata)

     c/ICloneable
     (-clone [this]
       (compact this)
       (ObjectsMap. metadata {} data false nil))

     c/IIterable
     (-iterator [this]
       (c/seq-iter this))

     c/ICollection
     (-conj [this entry]
       (cond
         (map-entry? entry)
         (c/-assoc this (c/-key entry) (c/-val entry))

         (vector? entry)
         (c/-assoc this (c/-nth entry 0) (c/-nth entry 1))

         :else
         (loop [ret this es (seq entry)]
           (if (nil? es)
             ret
             (let [e (first es)]
               (if (or (map-entry? e) (vector? e))
                 (recur (c/-assoc ret (c/-nth e 0) (c/-nth e 1))
                        (next es))
                 (throw (js/Error. "conj on a map takes map entries or seqables of map entries"))))))))

     c/IEmptyableCollection
     (-empty [_]
       (ObjectsMap. metadata {} {} false nil))

     c/IEquiv
     (-equiv [this other]
       (equiv-map this other))

     c/IHash
     (-hash [this]
       (when-not hash
         (set! hash (hash-unordered-coll this)))
       hash)

     c/ISeqable
     (-seq [this]
       (->> (keys data)
            (map (fn [id] (new ObjectsMapEntry id this)))
            (seq)))

     c/ICounted
     (-count [_]
       (c/-count data))

     c/ILookup
     (-lookup [this k]
       (if (c/-contains-key? cache k)
         (c/-lookup cache k)
         (if (c/-contains-key? data k)
           (let [v (c/-lookup data k)
                 v (t/decode-str v)]
             (set! (.-cache this) (c/-assoc cache k v))
             v)
           (do
             (set! (.-cache this) (c/-assoc cache k nil))
             nil))))

     (-lookup [this k not-found]
       (if (c/-contains-key? data k)
         (c/-lookup this k)
         not-found))

     c/IAssociative
     (-assoc [_ k v]
       (ObjectsMap. metadata
                    (c/-assoc cache k v)
                    (c/-assoc data k nil)
                    true
                    nil))

     (-contains-key? [_ k]
       (c/-contains-key? data k))

     c/IFind
     (-find [this k]
       (when (c/-contains-key? data k)
         (new ObjectsMapEntry k this)))

     c/IMap
     (-dissoc [_ k]
       (ObjectsMap. metadata
                    (c/-dissoc cache k)
                    (c/-dissoc data k)
                    true
                    nil))

     c/IKVReduce
     (-kv-reduce [this f init]
       (c/-kv-reduce data
                     (fn [init k _]
                       (f init k (c/-lookup this k)))
                     init))

     c/IFn
     (-invoke [this k]
       (c/-lookup this k))
     (-invoke [this k not-found]
       (c/-lookup this k not-found))

     c/IPrintWithWriter
     (-pr-writer [this writer opts]
       (c/pr-sequential-writer
        writer
        (fn [item w _]
          (c/-write w (pr-str (c/-key item)))
          (c/-write w \space)
          (c/-write w (pr-str (c/-val item))))
        "#penpot/objects-map {" ", " "}"
        opts
        (seq this))))

   :clj
   (deftype ObjectsMap [metadata cache
                        ^:unsynchronized-mutable data
                        ^:unsynchronized-mutable modified
                        ^:unsynchronized-mutable hash]

     clojure.lang.MapEquivalence

     clojure.lang.IObj
     (withMeta [this new-meta]
       (if (identical? new-meta metadata)
         this
         (ObjectsMap. new-meta cache data modified hash)))

     clojure.lang.IMeta
     (meta [_] metadata)

     clojure.lang.IFn
     (invoke [this k]
       (get this k))
     (invoke [this k not-found]
       (get this k not-found))
     (applyTo [this arglist]
       (clojure.lang.AFn/applyToHelper this arglist))

     java.util.Map
     (size [this]
       (count this))
     (isEmpty [this]
       (zero? (count this)))
     (containsValue [this v]
       (boolean (some #(= v %) (vals this))))
     (get [this k]
       (get this k))
     (put [_ _ _]
       (throw (UnsupportedOperationException. "objects map is immutable")))
     (remove [_ _]
       (throw (UnsupportedOperationException. "objects map is immutable")))
     (putAll [_ _]
       (throw (UnsupportedOperationException. "objects map is immutable")))
     (clear [_]
       (throw (UnsupportedOperationException. "objects map is immutable")))
     (keySet [this]
       (set (keys this)))
     (values [this]
       (vec (vals this)))
     (entrySet [this]
       (set (seq this)))

     Object
     (hashCode [this]
       ;; The java.util.Map contract: the sum of key ^ value hash codes.
       (unchecked-int
        (reduce (fn [acc e]
                  (+ acc (bit-xor (java.util.Objects/hashCode (key e))
                                  (java.util.Objects/hashCode (val e)))))
                0
                (seq this))))
     (equals [this other]
       (= this other))

     cp/Datafiable
     (datafy [_]
       {:data data
        :cache cache
        :modified modified
        :hash hash})

     IObjectsMap
     (compact [this]
       (locking this
         (when modified
           (do-compact data cache
                       (fn [data']
                         (set! (.-modified this) false)
                         (set! (.-data this) data')))))
       this)

     (get-data [this]
       (compact this)
       data)

     (-raw-data [_]
       data)

     (-hash-for-key [this key]
       (if (contains? cache key)
         (c/hash (get cache key))
         (c/hash (get this key))))

     json/JSONWriter
     (-write [this writter options]
       (json/-write (into {} this) writter options))

     clojure.lang.IHashEq
     (hasheq [this]
       (when-not hash
         (set! hash (Murmur3/hashUnordered this)))
       hash)

     clojure.lang.Seqable
     (seq [this]
       (RT/chunkIteratorSeq (.iterator ^Iterable this)))

     java.lang.Iterable
     (iterator [this]
       (ObjectsMapIterator. (.iterator ^Iterable data) this))

     clojure.lang.IPersistentCollection
     (equiv [this other]
       (and (or (instance? clojure.lang.IPersistentMap other)
                (instance? java.util.Map other))
            (= (count this) (count other))
            (every? (fn [e]
                      (let [k (key e)]
                        (and (contains? other k)
                             (= (val e) (get other k)))))
                    (seq this))))

     clojure.lang.IPersistentMap
     (cons [this o]
       (cond
         (map-entry? o)
         (assoc this (key o) (val o))

         (vector? o)
         (if (== 2 (count o))
           (assoc this (nth o 0) (nth o 1))
           (throw (IllegalArgumentException. "Vector arg to map conj must be a pair")))

         :else
         (reduce (fn [acc e]
                   (assoc acc (key e) (val e)))
                 this
                 (seq o))))

     (empty [_]
       (ObjectsMap. metadata {} {} false nil))

     (containsKey [_ key]
       (.containsKey ^clojure.lang.IPersistentMap data key))

     (entryAt [this key]
       (when (.containsKey ^clojure.lang.IPersistentMap data key)
         (ObjectsMapEntry. key this)))

     (valAt [this key]
       (if (contains? cache key)
         (get cache key)
         (locking this
           (if (contains? data key)
             (let [value (get data key)
                   value (t/decode-str value)]
               (set! (.-cache this) (assoc cache key value))
               value)
             (do
               (set! (.-cache this) (assoc cache key nil))
               nil)))))

     (valAt [this key not-found]
       (if (.containsKey ^clojure.lang.IPersistentMap data key)
         (.valAt this key)
         not-found))

     (assoc [_ key val]
       (ObjectsMap. metadata
                    (assoc cache key val)
                    (assoc data key nil)
                    true
                    nil))


     (assocEx [_ _ _]
       (throw (UnsupportedOperationException. "method not implemented")))

     (without [_ key]
       (ObjectsMap. metadata
                    (dissoc cache key)
                    (dissoc data key)
                    true
                    nil))

     clojure.lang.Counted
     (count [_]
       (count data))))

#?(:cljs (es6-iterable ObjectsMap))


(defn- do-compact
  [data cache update-fn]
  (let [new-data
        (persistent!
         (reduce-kv (fn [data id obj]
                      (if (nil? obj)
                        (assoc! data id (t/encode-str (get cache id)))
                        data))
                    (transient data)
                    data))]
    (update-fn new-data)
    nil))

(defn from-data
  [data]
  (ObjectsMap. {} {}
               data
               false
               nil))

(defn objects-map?
  [o]
  (instance? ObjectsMap o))

(defn raw-data
  "Returns the id -> encoded value map of an objects map, without
  compacting it. A value is nil when the entry was set after the map was
  decoded. Returns nil for anything that is not an objects map."
  [o]
  (when (objects-map? o)
    (-raw-data o)))

(defn raw-value
  "Returns the encoded value of the entry `k`, as stored in the raw data."
  [o k]
  (get (raw-data o) k))

(defn create
  ([] (from-data {}))
  ([other]
   (cond
     (objects-map? other)
     (-> other get-data from-data)

     :else
     (throw #?(:clj (UnsupportedOperationException. "invalid arguments")
               :cljs (js/Error. "invalid arguments"))))))

(defn wrap
  [objects]
  (if (instance? ObjectsMap objects)
    objects
    (->> objects
         (into (create))
         (compact))))

#?(:clj
   (fres/add-handlers!
    {:name "penpot/objects-map/v2"
     :class ObjectsMap
     :wfn (fn [n w o]
            (fres/write-tag! w n)
            (fres/write-object! w (get-data o)))
     :rfn (fn [r]
            (-> r fres/read-object! from-data))}))

(t/add-handlers!
 {:id "penpot/objects-map/v2"
  :class ObjectsMap
  :wfn get-data
  :rfn from-data})

#?(:cljs
   (do
     (defn raw-entries
       "Return the raw ids and encoded strings of `o` as `#js {:ids :strs}`.
       Entries with no raw string yet are encoded here."
       [o]
       (let [^js ids  #js []
             ^js strs #js []]
         (reduce-kv
          (fn [_ id s]
            (.push ids (str id))
            (.push strs (or s (t/encode-str (get o id))))
            nil)
          nil
          (raw-data o))
         #js {:ids ids :strs strs}))

     (defn from-raw-entries
       "Build an ObjectsMap from the `#js {:ids :strs}` made by `raw-entries`.
       The strings stay encoded until a shape is read."
       [^js raw]
       (let [^js ids  (.-ids raw)
             ^js strs (.-strs raw)
             data     (loop [i    0
                             data (transient {})]
                        (if (< i (.-length ids))
                          (recur (inc i)
                                 (assoc! data
                                         (uuid/uuid (aget ids i))
                                         (aget strs i)))
                          (persistent! data)))]
         (from-data data)))))
