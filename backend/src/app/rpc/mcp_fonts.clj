;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.mcp-fonts
  "Font report of the backend-native MCP: the fonts that the text runs of a
  page, or of some subtrees, use, and what each one resolves to and why not.
  Pure logic for `app.rpc.commands.mcp-fonts` and for the outline warnings in
  `app.rpc.commands.mcp`. It must not require `app.rpc.commands.mcp`.

  The usage of a page (which fonts its text uses) is cached per page; the
  resolution of the fonts is read on every call, because it depends on the
  flags and on the team's font variants."
  (:require
   [app.binfile.common :as bfc]
   [app.common.exceptions :as ex]
   [app.common.fonts :as fonts]
   [app.common.fonts.builtin :as builtin]
   [app.common.logging :as l]
   [app.common.types.text :as txt]
   [app.config :as cf]
   [app.util.cache :as cache]
   [app.util.pointer-map :as pmap]
   [cuerdas.core :as str]))

(def scan-budget-ns
  "Time a whole-file font report (`get-mcp-fonts` without `page-id`) may
  spend: five seconds. Past it the walk stops and reports `complete` false."
  5000000000)

(def outline-budget-ns
  "Time the font warnings of one file outline may spend: one second. Pages
  scanned in one call are cached, so the next call goes further."
  1000000000)

(def outline-max-shapes
  "Largest page the file outline scans for its font warnings. A bigger page is
  left out until `get-mcp-fonts` has cached its usage, so the first outline of
  a large file stays quick."
  5000)

(def ^:private default-font-id
  "The font a text run uses when its leaf names none."
  "sourcesanspro")

(def ^:private cut-check-every
  "Shapes between two looks at the clock while one page is scanned."
  256)

(def ^:private gfont-index
  "The Google catalogue by font id, read by `app.common.fonts` once, on first
  use. A catalogue that cannot be read is logged once, and the index is then
  empty: a `delay` keeps a failure, so the failure is not raised again."
  (delay
    (try
      (into {}
            (map (juxt :id identity))
            (fonts/load-gfonts fonts/gfonts-resource))
      (catch Throwable cause
        (l/err :hint "unable to read the google fonts catalogue"
               :cause cause)
        {}))))

(def ^:private builtin-index
  "The bundled families by font id."
  (into {} (map (juxt :id identity)) builtin/local-fonts))

;; --- USAGE OF A PAGE

(defn- get-leaf-font-id
  "The font id of a text run, the default font when it names none."
  [leaf]
  (or (:font-id leaf) default-font-id))

(defn- get-run-variant-id
  "The variant id of a text run: the stored `font-variant-id`, else the style
  and weight joined as the editor joins them for custom fonts. A run that
  stores no id is matched to a variant of its font by weight and style."
  [leaf]
  (or (:font-variant-id leaf)
      (str (or (:font-style leaf) "normal") "-" (or (:font-weight leaf) "400"))))

(defn- get-text-runs
  "The runs of a text shape: its leaves that carry text. An empty leaf is not
  a run."
  [shape]
  (when-let [content (:content shape)]
    (filter #(seq (:text %))
            (txt/node-seq txt/is-text-node? content))))

(defn- add-variant
  "`variants` with one more run of the variant `variant`."
  [variants variant]
  (update variants (:variant-id variant)
          (fn [old]
            (if (some? old)
              (update old :runs + (:runs variant))
              variant))))

(defn- add-run
  "`usage` with the text run `leaf` added to its font."
  [usage leaf]
  (let [font-id (get-leaf-font-id leaf)
        variant {:variant-id (get-run-variant-id leaf)
                 :weight (str (or (:font-weight leaf) "400"))
                 :style (or (:font-style leaf) "normal")
                 :runs 1}]
    (update usage font-id
            (fn [entry]
              (-> (or entry {:runs 0 :shapes 0 :variants {}})
                  (update :family #(or % (:font-family leaf)))
                  (update :runs inc)
                  (update :variants add-variant variant))))))

(defn- add-shape
  "`usage` with the text shape `shape`: each run, and one shape for each font
  it uses."
  [usage shape]
  (let [leaves (get-text-runs shape)]
    (reduce (fn [usage font-id] (update-in usage [font-id :shapes] inc))
            (reduce add-run usage leaves)
            (into #{} (map get-leaf-font-id) leaves))))

(defn- get-objects-usage
  "The usage of the text shapes of `objects` among `ids` (all shapes when
  `ids` is nil), as `{:usage map :complete bool}`. With `cut-at` (a nanoTime),
  the scan stops once past it, with `:complete false` and no usage."
  [objects ids cut-at]
  (let [shapes (if (nil? ids)
                 (vals objects)
                 (keep #(get objects %) ids))]
    (loop [shapes (seq shapes)
           usage  {}
           n      0]
      (cond
        (nil? shapes)
        {:usage usage :complete true}

        (and (some? cut-at)
             (zero? (mod n cut-check-every))
             (> (System/nanoTime) cut-at))
        {:usage nil :complete false}

        :else
        (let [shape (first shapes)]
          (recur (next shapes)
                 (if (= :text (:type shape))
                   (add-shape usage shape)
                   usage)
                 (inc n)))))))

(defn- usage-weight
  "Weight of a cached page usage: its number of fonts, and at least one."
  [usage]
  (max 1 (count usage)))

(defonce ^:private usage-cache
  (cache/create :expire "10m"
                :weigher usage-weight
                :max-weight 200000))

(defn get-page-key
  "The key of page `page-id` in the usage cache, the way the outline caches
  a page: a pointer map by its pointer id, a plain page by file, vern, page
  and revision."
  [file-id vern revn data page-id]
  (let [page (get-in data [:pages-index page-id])]
    (if (pmap/pointer-map? page)
      [:pointer (pmap/get-id page)]
      [file-id vern page-id revn])))

(defn- get-cached-usage
  "The usage of a whole page under `page-key`, from `usage-cache` when it is
  there (`:hit` true), else scanned with `load-objects` and cached when the
  scan completes."
  [page-key load-objects cut-at]
  (if-let [usage (cache/get usage-cache page-key)]
    {:usage usage :complete true :hit true}
    (let [result (get-objects-usage (load-objects) nil cut-at)]
      (when (:complete result)
        (cache/put usage-cache page-key (:usage result)))
      result)))

(defn get-subtree-ids
  "The ids of the shapes under `root-ids` in `objects`, the roots included, as
  a set. A shape reached twice, or a cycle in `:shapes`, is walked once.
  Raises `:shape-not-found` for a root the page does not hold."
  [objects root-ids]
  (loop [roots   (seq root-ids)
         visited #{}]
    (if (nil? roots)
      visited
      (let [root (first roots)]
        (when-not (contains? objects root)
          (ex/raise :type :not-found
                    :code :shape-not-found
                    :hint "root shape not found on the page"))
        (recur (next roots)
               (loop [stack   [root]
                      visited visited]
                 (if (empty? stack)
                   visited
                   (let [id    (peek stack)
                         stack (pop stack)]
                     (if (contains? visited id)
                       (recur stack visited)
                       (recur (into stack (:shapes (get objects id)))
                              (conj visited id)))))))))))

(defn get-pages-usage
  "The usage of the pages `pages`, a vector of `{:id page-id :key page-key}`
  in page order. Pages are read through `usage-cache`; `load-objects` gives the
  objects of a page id and runs only on a miss. With `root-ids` the usage is
  limited to those subtrees, and nothing is cached.

  The walk runs within `budget-ns` (nil: no budget). The first page that is
  scanned in a call always completes, so a call always makes progress. After
  that, a page that starts past the budget ends the walk, and a page the budget
  cuts is not cached and ends it too. Returns `{:page-usages [[page-id usage]
  ...] :complete bool}`, where `:complete` is false when pages were left out.

  With `max-shapes` (the outline), a page of more shapes than that is not
  scanned unless its usage is cached: it is left out, and `:complete` is
  false. Each page entry then carries its `:shape-count`."
  [{:keys [pages load-objects root-ids budget-ns max-shapes]}]
  (let [deadline (when (some? budget-ns)
                   (+ (System/nanoTime) budget-ns))]
    (loop [pending pages
           out     []
           misses  0
           left    false]
      (cond
        (empty? pending)
        {:page-usages out :complete (not left)}

        (and (some? deadline)
             (pos? misses)
             (> (System/nanoTime) deadline))
        {:page-usages out :complete false}

        (and (some? max-shapes)
             (> (or (:shape-count (first pending)) 0) max-shapes)
             (nil? (cache/get usage-cache (:key (first pending)))))
        (recur (rest pending) out misses true)

        :else
        (let [{page-id :id page-key :key} (first pending)
              cut-at (when (pos? misses) deadline)
              result (if (seq root-ids)
                       (let [objects (load-objects page-id)]
                         (get-objects-usage objects
                                            (get-subtree-ids objects root-ids)
                                            cut-at))
                       (get-cached-usage page-key #(load-objects page-id) cut-at))]
          (if (:complete result)
            (recur (rest pending)
                   (conj out [page-id (:usage result)])
                   (if (:hit result) misses (inc misses))
                   left)
            {:page-usages out :complete false}))))))

;; --- RESOLUTION

(defn get-font-context
  "What the resolution needs from the host, read on every call: the Google
  flag, the public uri, and the live font variants of `team-id` by font id."
  [cfg team-id]
  {:google-on (contains? cf/flags :google-fonts-provider)
   :public-uri (cf/get :public-uri)
   :team-fonts (group-by #(str "custom-" (:font-id %))
                         (bfc/get-fonts cfg team-id))})

(defn- get-font-source
  "Where font `font-id` comes from: `:builtin` for a bundled family, `:google`
  for a `gfont-` id, `:custom` for a `custom-` id, else `:unknown`."
  [font-id]
  (cond
    (contains? builtin-index font-id) :builtin
    (and (string? font-id)
         (str/starts-with? font-id "gfont-")) :google
    (and (string? font-id)
         (str/starts-with? font-id "custom-")) :custom
    :else :unknown))

(defn- get-builtin-listing
  "The family and variants of a bundled font. Bundled urls are not reported."
  [font-id]
  (when-let [font (get builtin-index font-id)]
    {:family (:name font)
     :variants (mapv (fn [v] {:id (:id v) :weight (:weight v) :style (:style v) :url nil})
                     (:variants font))}))

(defn- get-google-listing
  "The family and variants of a Google catalogue font, or nil."
  [font-id]
  (when-let [font (get @gfont-index font-id)]
    {:family (:family font)
     :variants (mapv (fn [v] {:id (:id v) :weight (:weight v) :style (:style v) :url (:ttf-url v)})
                     (:variants font))}))

(defn- get-custom-url
  "The assets url of a team font variant: its TTF, else the first other file
  it stores, or nil when it stores none."
  [ctx row]
  (when-let [file-id (or (:ttf-file-id row)
                         (:otf-file-id row)
                         (:woff2-file-id row)
                         (:woff1-file-id row))]
    (str (str/rtrim (str (:public-uri ctx)) "/") "/assets/by-id/" file-id)))

(defn- get-custom-listing
  "The family and variants of a custom font of the team, or nil."
  [ctx font-id]
  (when-let [rows (seq (get (:team-fonts ctx) font-id))]
    {:family (:font-family (first rows))
     :variants (mapv (fn [row]
                       {:id (str (:font-style row) "-" (:font-weight row))
                        :weight (str (:font-weight row))
                        :style (:font-style row)
                        :url (get-custom-url ctx row)})
                     rows)}))

(defn- get-font-listing
  "The family and variants that font `font-id` of `source` has, or nil."
  [ctx font-id source]
  (case source
    :builtin (get-builtin-listing font-id)
    :google (get-google-listing font-id)
    :custom (get-custom-listing ctx font-id)
    nil))

(defn- get-font-reason
  "Why font `font-id` does not resolve, or nil when it does."
  [ctx source listing]
  (case source
    :builtin nil
    :google (cond
              (not (:google-on ctx)) "google-fonts-disabled"
              (nil? listing)         "not-in-google-catalog"
              :else                  nil)
    :custom (when (nil? listing) "custom-font-not-in-team")
    "unknown-font-id"))

(defn- get-listed-variant
  "The variant of `listing` that the run variant `v` is: the one with its id,
  else the one with its weight and style. Nil when the font has neither."
  [listing v]
  (or (some #(when (= (:variant-id v) (:id %)) %) listing)
      (some #(when (and (= (:weight v) (:weight %))
                        (= (:style v) (:style %)))
               %)
            listing)))

(defn- get-variant-status
  "Resolution of a variant: `listed` is the catalogue variant it is, or nil."
  [reason listed]
  (cond
    (some? reason)     {:resolved false :reason reason}
    (nil? listed)      {:resolved false :reason "variant-not-found"}
    (some? (:url listed)) {:resolved true :url (:url listed)}
    :else              {:resolved true}))

(defn- get-variant-reports
  "The variants of a font, one per face: the runs of the usage variants that
  name the same face are merged. A run names its face by id, else by weight
  and style. A run that names no face keeps its own id, marked
  `variant-not-found`."
  [reason listing usage-variants]
  (->> usage-variants
       (reduce (fn [acc v]
                 (let [listed (when (nil? reason)
                                (get-listed-variant listing v))
                       id     (if (some? listed) (:id listed) (:variant-id v))]
                   (update acc id
                           (fn [old]
                             (if (some? old)
                               (update old :runs + (:runs v))
                               (merge {:variant-id id
                                       :weight (if (some? listed) (:weight listed) (:weight v))
                                       :style (if (some? listed) (:style listed) (:style v))
                                       :runs (:runs v)}
                                      (get-variant-status reason listed)))))))
               {})
       (vals)
       (sort-by :variant-id)
       (vec)))

(defn get-font-report
  "The report of font `font-id` from its usage `entry` (see `get-pages-usage`),
  in the context `ctx` (see `get-font-context`): source, resolution and reason,
  family, runs, shapes and variants. The resolution is not cached."
  [ctx font-id entry]
  (let [source  (get-font-source font-id)
        listing (get-font-listing ctx font-id source)
        reason  (get-font-reason ctx source listing)]
    (cond-> {:font-id font-id
             :family (or (:family listing) (:family entry) font-id)
             :source source
             :resolved (nil? reason)
             :runs (:runs entry)
             :shapes (:shapes entry)
             :variants (get-variant-reports reason (:variants listing)
                                            (vals (:variants entry)))}
      (some? reason) (assoc :reason reason))))

(defn- merge-variants
  "`variants` with the runs of the variants of one page, `page-variants`, added."
  [variants page-variants]
  (reduce-kv (fn [acc vid v]
               (update acc vid (fn [old]
                                 (if (some? old)
                                   (update old :runs + (:runs v))
                                   v))))
             (or variants {})
             page-variants))

(defn- add-page-entry
  "`total` with the usage `entry` of font `font-id` on page `page-id` added."
  [total page-id font-id entry]
  (update total font-id
          (fn [t]
            (-> (or t {:runs 0 :shapes 0 :pages [] :variants {}})
                (update :family #(or % (:family entry)))
                (update :runs + (:runs entry))
                (update :shapes + (:shapes entry))
                (update :pages conj {:page-id page-id :runs (:runs entry)})
                (update :variants merge-variants (:variants entry))))))

(defn get-fonts-report
  "The fonts that the pages use. `page-usages` is a vector of `[page-id usage]`
  in page order. Each font carries its totals, its `:pages` (with the runs per
  page) and its variants. Fonts sort by runs, descending, then by id."
  [ctx page-usages]
  (let [totals (reduce (fn [acc [page-id usage]]
                         (reduce-kv (fn [acc font-id entry]
                                      (add-page-entry acc page-id font-id entry))
                                    acc
                                    usage))
                       {}
                       page-usages)]
    (->> totals
         (map (fn [[font-id entry]]
                (assoc (get-font-report ctx font-id entry) :pages (:pages entry))))
         (sort-by (juxt (comp - :runs) :font-id))
         (vec))))

(defn get-outline-warnings
  "The `font-unresolved` warnings of the pages `page-usages` (see
  `get-pages-usage`): one per page and unresolved font, pages in order, fonts
  by runs. Returns all of them; the caller caps the reply."
  [ctx page-usages]
  (into []
        (mapcat (fn [[page-id usage]]
                  (->> usage
                       (map (fn [[font-id entry]] (get-font-report ctx font-id entry)))
                       (remove :resolved)
                       (sort-by (juxt (comp - :runs) :font-id))
                       (map (fn [font]
                              {:kind "font-unresolved"
                               :font-id (:font-id font)
                               :family (:family font)
                               :reason (:reason font)
                               :page-id page-id
                               :runs (:runs font)})))))
        page-usages))
