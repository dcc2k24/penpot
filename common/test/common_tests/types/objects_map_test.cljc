;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns common-tests.types.objects-map-test
  (:require
   #?(:clj [app.common.fressian :as fres])
   [app.common.json :as json]
   [app.common.pprint :as pp]
   [app.common.schema :as sm]
   [app.common.schema.generators :as sg]
   [app.common.schema.test :as smt]
   [app.common.transit :as transit]
   [app.common.types.objects-map :as omap]
   [app.common.types.path :as path]
   [app.common.types.plugins :refer [schema:plugin-data]]
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [clojure.datafy :refer [datafy]]
   [clojure.test :as t]))

(t/deftest basic-operations
  (t/testing "assoc"
    (let [id  (uuid/custom 0 1)
          id' (uuid/custom 0 2)
          obj (-> (omap/create) (assoc id {:foo 1}))]
      (t/is (not= id id'))
      (t/is (not (contains? obj id')))
      (t/is (contains? obj id))))

  (t/testing "assoc-with-non-uuid-keys"
    (let [obj (-> (omap/create)
                  (assoc :a {:foo 1})
                  (assoc :b {:bar 1}))]
      (t/is (not (contains? obj :c)))
      (t/is (contains? obj :a))
      (t/is (contains? obj :b))))

  (t/testing "dissoc"
    (let [id  (uuid/custom 0 1)
          obj (-> (omap/create) (assoc id {:foo 1}))]
      (t/is (contains? obj id))
      (let [obj (dissoc obj id)]
        (t/is (not (contains? obj id))))))

  (t/testing "seq"
    (let [id  (uuid/custom 0 1)
          obj (-> (omap/create) (assoc id 1))]
      (t/is (contains? obj id))
      (let [[entry] (seq obj)]
        (t/is (map-entry? entry))
        (t/is (= (key entry) id))
        (t/is (= (val entry) 1)))))

  (t/testing "cons & count"
    (let [obj (into (omap/create) [[uuid/zero 1]])]
      (t/is (contains? obj uuid/zero))
      (t/is (= 1 (count obj)))
      (t/is (omap/objects-map? obj))))

  (t/testing "wrap"
    (let [obj1 (omap/wrap {})
          tmp  (omap/create)
          obj2 (omap/wrap tmp)]
      (t/is (omap/objects-map? obj1))
      (t/is (omap/objects-map? obj2))
      (t/is (identical? tmp obj2))
      (t/is (= 0 (count obj1)))
      (t/is (= 0 (count obj2))))))

(t/deftest internal-state
  (t/testing "modified & compact"
    (let [obj (-> (omap/create)
                  (assoc :a 1)
                  (assoc :b 2))]
      (t/is (= 2 (count obj)))
      (t/is (-> obj datafy :modified))
      (let [obj (omap/compact obj)]
        (t/is (not (-> obj datafy :modified))))))

  (t/testing "create from other"
    (let [obj1 (-> (omap/create)
                   (assoc :a {:foo 1})
                   (assoc :b {:bar 2}))
          obj2 (omap/create obj1)]

      (t/is (not (identical? obj1 obj2)))
      (t/is (= obj1 obj2))
      (t/is (= (hash obj1) (hash obj2)))
      (t/is (= (get obj1 :a) (get obj2 :a)))
      (t/is (= (get obj1 :b) (get obj2 :b))))))

(t/deftest creation-and-duplication
  (smt/check!
   (smt/for [data (->> (sg/map-of (sg/uuid) (sg/generator cts/schema:shape))
                       (sg/not-empty))]
     (let [obj1 (omap/wrap data)
           obj2 (omap/create obj1)]
       (and (= (hash obj1) (hash obj2))
            (= obj1 obj2))))
   {:num 100}))

#?(:clj
   (t/deftest fressian-encode-decode
     (smt/check!
      (smt/for [data (->> (sg/map-of (sg/uuid) (sg/generator cts/schema:shape))
                          (sg/not-empty)
                          (sg/fmap omap/wrap)
                          (sg/fmap (fn [o] {:objects o})))]

        (let [res (-> data fres/encode fres/decode)]
          (and (contains? res :objects)
               (omap/objects-map? (:objects res))
               (= res data))))
      {:num 100})))

(t/deftest find-and-select-keys-on-loaded-map
  ;; A fresh map (as one decoded from the database) holds encoded
  ;; values. find, select-keys, into, keys and vals must read them.
  (let [id1  (uuid/custom 0 1)
        id2  (uuid/custom 0 2)
        id3  (uuid/custom 0 3)
        obj1 {:id id1 :name "first"}
        obj2 {:id id2 :name "second"}
        obj  (omap/create (omap/wrap {id1 obj1 id2 obj2}))]

    (t/testing "find returns an entry with the uuid and the decoded object"
      (let [entry (find obj id1)]
        (t/is (map-entry? entry))
        (t/is (= id1 (key entry)))
        (t/is (= obj1 (val entry)))))

    (t/testing "find of a missing key is nil"
      (t/is (nil? (find obj id3))))

    (t/testing "select-keys keeps the present keys and drops the missing one"
      (let [result (select-keys obj [id1 id3 id2])]
        (t/is (= {id1 obj1 id2 obj2} result))
        (t/is (= 2 (count result)))))

    (t/testing "into, keys and vals agree with get"
      (let [m (into {} obj)]
        (t/is (= {id1 obj1 id2 obj2} m))
        (t/is (= #{id1 id2} (set (keys obj))))
        (t/is (= #{obj1 obj2} (set (vals obj))))
        (doseq [k (keys obj)]
          (t/is (= (get obj k) (get m k))))))))

(defn- loaded-copy
  "Returns `data` as an objects map that holds encoded values, the way a
  map read back from the database does."
  [data]
  (-> {:objects (omap/wrap data)}
      (transit/encode-str)
      (transit/decode-str)
      (:objects)))

(defn- same-as-plain?
  "True when the objects map `m` answers each read the way the plain
  map `plain` does. `plain` must not be empty."
  [plain m]
  (let [ks     (keys plain)
        k      (first ks)
        absent (uuid/custom 9 9)
        ks+    (cons absent ks)]
    (and (= plain m)
         (= m plain)
         (= (hash plain) (hash m))
         (= (count plain) (count m))
         (= (set (keys plain)) (set (keys m)))
         (= (set (vals plain)) (set (vals m)))
         (= (set plain) (set m))
         (= (into {} m) plain)
         (= (reduce-kv (fn [acc k v] (assoc acc k v)) {} m) plain)
         (every? (fn [id]
                   (and (= (get plain id) (get m id))
                        (= (find plain id) (find m id))
                        (= (plain id) (m id))
                        (= (contains? plain id) (contains? m id))))
                 ks)
         (nil? (find m absent))
         (not (contains? m absent))
         (= :nf (get m absent :nf))
         (= (select-keys plain ks+) (select-keys m ks+))
         (= (merge plain {absent 1}) (merge m {absent 1}))
         (= (into plain {absent 1}) (into m {absent 1}))
         (= (dissoc plain k) (dissoc m k))
         (= (assoc plain absent 1) (assoc m absent 1))
         (= (empty plain) (empty m)))))

(t/deftest map-entry-equality-and-access
  (let [id    (uuid/custom 0 1)
        obj   {:id id :name "first"}
        plain {id obj}
        m     (loaded-copy plain)
        e     (find m id)]
    (t/is (map-entry? e))
    (t/is (= e [id obj]))
    (t/is (= [id obj] e))
    (t/is (not= e [id {}]))
    (t/is (= (first plain) (first m)))
    (t/is (= (first m) (first plain)))
    (t/is (= (hash e) (hash [id obj])))
    (t/is (= (hash (first m)) (hash (first plain))))
    (t/is (= id (key e)))
    (t/is (= obj (val e)))
    (t/is (= id (nth e 0)))
    (t/is (= obj (nth e 1)))
    (t/is (= [id obj] (let [[k v] e] [k v])))
    (t/is (= [id obj] (seq e)))
    (t/is (= {id obj} (into {} [e])))))

(t/deftest metadata-on-loaded-map
  (let [id (uuid/custom 0 1)
        m  (loaded-copy {id {:a 1}})
        m' (with-meta m {:tag :x})]
    (t/is (= {:tag :x} (meta m')))
    (t/is (= {:tag :x} (meta (empty m'))))
    (t/is (= m' m))
    (t/is (= {id {:a 1}} m'))
    (t/is (= {:a 1} (get m' id)))
    (t/is (= 1 (count m')))))

(t/deftest conj-merge-and-into-on-loaded-map
  (let [id1   (uuid/custom 0 1)
        id2   (uuid/custom 0 2)
        base  {id1 {:a 1}}
        extra {id2 {:b 2}}
        m     (loaded-copy base)]
    (t/is (= (merge base extra) (merge m extra)))
    (t/is (= (into base extra) (into m extra)))
    (t/is (= (conj base extra) (conj m extra)))
    (t/is (= (merge base (loaded-copy extra)) (merge m (loaded-copy extra))))
    (t/is (= (into base (loaded-copy extra)) (into m (loaded-copy extra))))
    (t/is (= (into base [[id2 {:b 2}]]) (into m [[id2 {:b 2}]])))
    (t/is (= (conj base (first extra)) (conj m (first extra))))
    (t/is (= (count (merge m extra)) 2))
    (t/is (= {:b 2} (get (merge m extra) id2)))
    (t/is (= m (conj m nil)))))

(t/deftest invoke-loaded-map
  (let [id1 (uuid/custom 0 1)
        id2 (uuid/custom 0 2)
        m   (loaded-copy {id1 {:a 1}})]
    (t/is (= {:a 1} (m id1)))
    (t/is (nil? (m id2)))
    (t/is (= :nf (m id2 :nf)))
    (t/is (= {:a 1} (apply m [id1])))
    (t/is (= {:a 1} (apply m [id1 :nf])))
    (t/is (= :nf (apply m [id2 :nf])))))

(t/deftest equality-with-plain-maps
  (let [id1   (uuid/custom 0 1)
        id2   (uuid/custom 0 2)
        plain {id1 {:a 1} id2 {:b 2}}
        m     (loaded-copy plain)]
    (t/is (= m plain))
    (t/is (= plain m))
    (t/is (not= m (dissoc plain id2)))
    (t/is (not= (dissoc plain id2) m))
    (t/is (not= m (assoc plain id1 {:a 2})))
    (t/is (not= (assoc plain id1 {:a 2}) m))
    (t/is (= (hash m) (hash plain)))
    (t/is (= #{plain} #{m}))
    (t/is (= {} (empty m)))
    (t/is (= (empty m) {}))
    #?(:clj
       (do
         (t/is (= m (java.util.HashMap. plain)))
         (t/is (= (java.util.HashMap. plain) m))
         (t/is (= (.hashCode ^Object plain) (.hashCode ^Object m)))
         (t/is (= (.hashCode ^Object plain) (.hashCode ^Object (loaded-copy plain))))))))

(t/deftest nil-and-false-values
  (let [id1   (uuid/custom 0 1)
        id2   (uuid/custom 0 2)
        id3   (uuid/custom 0 3)
        plain {id1 false id2 nil}
        fresh (-> (omap/create) (assoc id1 false) (assoc id2 nil))
        m     (loaded-copy plain)]
    (doseq [o [fresh m]]
      (t/is (false? (get o id1)))
      (t/is (nil? (get o id2 :nf)))
      (t/is (= :nf (get o id3 :nf)))
      (t/is (contains? o id2))
      (t/is (= plain (into {} o)))
      (t/is (= plain (select-keys o [id1 id2])))
      (t/is (= plain o)))))

(t/deftest loaded-map-behaves-like-plain-map
  (smt/check!
   (smt/for [data (->> (sg/map-of (sg/uuid) (sg/generator cts/schema:shape))
                       (sg/not-empty))]
     (same-as-plain? data (loaded-copy data)))
   {:num 30}))

(t/deftest transit-encode-decode
  (smt/check!
   (smt/for [data (->> (sg/map-of (sg/uuid) (sg/generator cts/schema:shape))
                       (sg/not-empty)
                       (sg/fmap omap/wrap)
                       (sg/fmap (fn [o] {:objects o})))]
     (let [res (-> data transit/encode-str transit/decode-str)]
       ;; (app.common.pprint/pprint data)
       ;; (app.common.pprint/pprint res)
       (and (every? (fn [[k v]]
                      (= v (get-in data [:objects k])))
                    (:objects res))
            (omap/objects-map? (:objects data))
            (omap/objects-map? (:objects res)))))
   {:num 100}))
