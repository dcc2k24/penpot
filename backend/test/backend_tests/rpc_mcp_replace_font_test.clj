;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-replace-font-test
  "The `replace_font` operation through `mcp-apply-operations`: the lookup of
  the target font, the reply, the dry run, the snapshot and the replay."
  (:require
   [app.binfile.common :as bfc]
   [app.common.json :as json]
   [app.common.types.shape :as cts]
   [app.common.types.text :as txt]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.http :as http]
   [app.http.access-token :as-alias actoken]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.access-token :as access-token]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.mcp-font-lookup :as font-lookup]
   [app.rpc.mcp-fonts :as mcp-fonts]
   [app.util.cache :as cache]
   [backend-tests.helpers :as th]
   [clojure.string :as str]
   [clojure.test :as t]
   [ring.core.protocols :as rcp]
   [yetti.response :as-alias yres]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware])
                       th/init-system))

(defn- clear-mcp-caches
  "Empties the MCP caches between tests: test files reuse the same file ids."
  [f]
  (doseq [c [@#'mcp/root-cache @#'mcp/page-cache @#'mcp/outline-cache
             @#'mcp-fonts/usage-cache]]
    (cache/invalidate c))
  (f))

(defn- with-google-flag
  "Turns the Google fonts flag on for each test, unless a test rebinds it."
  [f]
  (with-redefs [cf/flags (conj cf/flags :google-fonts-provider)]
    (f)))

(t/use-fixtures :each th/database-reset clear-mcp-caches with-google-flag)

;; --- HELPERS

(defn- call!
  "Runs an MCP command as `profile`, with an MCP token of `perms`."
  [profile method params & {:keys [perms]}]
  (th/command! (merge {::th/type method
                       ::rpc/profile-id (:id profile)
                       ::rpc/auth-type :token
                       ::rpc/token-type "mcp"
                       ::rpc/token-perms (or perms #{"mcp:write"})}
                      params)))

(defn- revn
  [file-id]
  (:revn (th/db-get :file {:id file-id})))

(defn- snapshot-labels
  "The labels of the MCP snapshots of `file-id`."
  [file-id]
  (into []
        (comp (map :label)
              (filter #(and (string? %) (str/starts-with? % "mcp/"))))
        (th/db-exec! ["SELECT label FROM file_change WHERE file_id = ? ORDER BY created_at ASC, id ASC"
                      file-id])))

(defn- stored-shape
  "The shape `id` of the stored file, as the file keeps it."
  [file-id page-id id]
  (let [file (bfc/get-file th/*system* file-id :realize? true)]
    (get-in file [:data :pages-index page-id :objects id])))

(defn- leaves-of
  [shape]
  (txt/node-seq txt/is-text-node? (:content shape)))

(def ^:private position-data
  [{:x 0 :y 0 :width 50 :height 24 :fills [] :font-family "Roboto"
    :font-size "20" :font-weight "700" :font-style "normal" :text "Hi"}])

(defn- roboto-leaf
  [text weight]
  {:text text :font-size "20" :font-id "gfont-roboto" :font-family "Roboto"
   :font-variant-id (if (= "400" weight) "regular" weight)
   :font-weight weight :font-style "normal"})

(defn- text-content
  [leaves]
  {:type "root"
   :children [{:type "paragraph-set"
               :children [{:type "paragraph" :children (vec leaves)}]}]})

(defn- add-text
  [page-id id leaves & {:as attrs}]
  {:type :add-obj
   :page-id page-id
   :id id
   :parent-id uuid/zero
   :frame-id uuid/zero
   :obj (cts/setup-shape (merge {:id id
                                 :type :text
                                 :name "Text"
                                 :parent-id uuid/zero
                                 :frame-id uuid/zero
                                 :x 0 :y 0 :width 100 :height 20
                                 :grow-type :fixed
                                 :position-data position-data
                                 :content (text-content leaves)}
                                attrs))})

(defn- insert-storage!
  []
  (let [id (uuid/next)]
    (db/insert! th/*pool* :storage-object
                {:id id
                 :size 9
                 :backend "fs"
                 :metadata (db/tjson {:bucket "team-font-variant"
                                      :content-type "font/ttf"})
                 :status "valid"})
    id))

(defn- insert-team-font!
  "A live team font variant, bold only, and the font id the texts use for it."
  [team-id font-uuid]
  (db/insert! th/*pool* :team-font-variant
              {:id (uuid/next)
               :team-id team-id
               :font-id font-uuid
               :font-family "Access Sans"
               :font-weight 700
               :font-style "normal"
               :variant-name "Bold"
               :ttf-file-id (insert-storage!)})
  (str "custom-" font-uuid))

(defn- create-fixture
  "A profile with a file whose page holds two texts on the Google font
  Roboto at weight 700 (`:t1`, `:t2`), and a team font `:custom-id` that has
  only the bold face."
  []
  (let [profile (th/create-profile* 1 {:is-active true})
        file    (th/create-file* 1 {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})
        team-id (:team-id (th/db-get :project {:id (:default-project-id profile)}))
        page-id (get-in file [:data :pages 0])
        t1      (uuid/next)
        t2      (uuid/next)]
    (th/update-file* {:file-id (:id file)
                      :profile-id (:id profile)
                      :revn (revn (:id file))
                      :changes [(add-text page-id t1 [(roboto-leaf "Hello" "700")])
                                (add-text page-id t2 [(roboto-leaf "World" "700")])]})
    {:profile (th/db-get :profile {:id (:id profile)})
     :file-id (:id file)
     :page-id page-id
     :t1 t1
     :t2 t2
     :custom-id (insert-team-font! team-id (uuid/next))}))

(defn- replace-op
  [page-id from to & {:as more}]
  (merge {:op "replace_font" :page-id page-id :from-font-id from :to-font-id to} more))

(defn- apply-ops!
  [profile file-id operations & {:as more}]
  (call! profile :mcp-apply-operations
         (merge {:file-id file-id :operations operations} more)))

;; --- TESTS

(t/deftest team-font-target-gets-the-workspace-variant-id
  (let [{:keys [profile file-id page-id t1 custom-id]} (create-fixture)
        out    (apply-ops! profile file-id [(replace-op page-id "gfont-roboto" custom-id)])
        leaf   (first (leaves-of (stored-shape file-id page-id t1)))]
    (t/is (nil? (:error out)))
    (t/is (= custom-id (:font-id leaf)))
    (t/is (= "Access Sans" (:font-family leaf)))
    (t/is (= "normal-700" (:font-variant-id leaf)))
    (t/is (= "700" (:font-weight leaf)))
    (t/is (= "normal" (:font-style leaf)))
    (t/testing "the layout data of a changed text is gone"
      (t/is (nil? (:position-data (stored-shape file-id page-id t1)))))
    (t/testing "the font report then resolves the font and its variant"
      (let [report (call! profile :get-mcp-fonts {:file-id file-id :page-id page-id}
                          :perms #{"mcp:read"})
            font   (first (filter #(= custom-id (:font-id %)) (:fonts (:result report))))
            variant (first (filter #(= "normal-700" (:variant-id %)) (:variants font)))]
        (t/is (true? (:resolved font)))
        (t/is (true? (:resolved variant)))))))

(t/deftest reply-holds-the-op-result
  (let [{:keys [profile file-id page-id t1 t2 custom-id]} (create-fixture)
        out    (apply-ops! profile file-id [(replace-op page-id "gfont-roboto" custom-id)])
        result (:result out)
        res    (first (:op-results result))]
    (t/is (= 1 (count (:op-results result))))
    (t/is (= "replace_font" (:op res)))
    (t/is (= 2 (:texts-changed res)))
    (t/is (= 2 (:runs-changed res)))
    (t/is (= 2 (:layout-dropped res)))
    (t/is (= #{t1 t2} (set (:layout-dropped-ids res))))
    (t/is (= [{:from {:weight "700" :style "normal"}
               :to {:variant-id "normal-700" :weight "700" :style "normal"}
               :exact true}]
             (:variants-used res)))
    (t/is (= 0 (get-in res [:skipped :total])))
    (t/is (= [] (:mains-changed res)))))

(t/deftest a-call-without-replace-font-has-no-op-results
  (let [{:keys [profile file-id page-id]} (create-fixture)
        out (apply-ops! profile file-id [{:op "create_board" :page-id page-id :id "$tmp:b"
                                          :name "B" :x 0 :y 0 :width 10 :height 10}])]
    (t/is (nil? (:error out)))
    (t/is (not (contains? (:result out) :op-results)))))

(t/deftest dry-run-returns-the-same-result-and-writes-nothing
  (let [{:keys [profile file-id page-id t1 custom-id]} (create-fixture)
        before  (revn file-id)
        shape   (stored-shape file-id page-id t1)
        op      (replace-op page-id "gfont-roboto" custom-id)
        dry     (apply-ops! profile file-id [op] :dry-run true)
        _       (t/is (nil? (:error dry)))
        _       (t/is (true? (:dry-run (:result dry))))
        _       (t/is (= before (revn file-id)))
        _       (t/is (= shape (stored-shape file-id page-id t1)))
        _       (t/is (empty? (snapshot-labels file-id)))
        real    (apply-ops! profile file-id [op])]
    (t/is (nil? (:error real)))
    (t/is (= (:op-results (:result dry)) (:op-results (:result real))))
    (t/is (= (inc before) (revn file-id)))))

(t/deftest a-call-that-changes-a-text-takes-a-snapshot
  (let [{:keys [profile file-id page-id custom-id]} (create-fixture)
        _   (t/is (empty? (snapshot-labels file-id)))
        out (apply-ops! profile file-id [(replace-op page-id "gfont-roboto" custom-id)])]
    (t/is (nil? (:error out)))
    (t/is (some? (:snapshot-id (:result out))))
    (t/is (= 1 (count (snapshot-labels file-id))))))

(t/deftest snapshot-false-takes-no-snapshot
  (let [{:keys [profile file-id page-id custom-id]} (create-fixture)
        out (apply-ops! profile file-id [(replace-op page-id "gfont-roboto" custom-id)]
                        :snapshot false)]
    (t/is (nil? (:error out)))
    (t/is (nil? (:snapshot-id (:result out))))
    (t/is (empty? (snapshot-labels file-id)))))

(t/deftest a-call-that-changes-no-text-takes-no-snapshot
  (let [{:keys [profile file-id page-id custom-id]} (create-fixture)
        out (apply-ops! profile file-id [(replace-op page-id "gfont-nothing-uses" custom-id)])]
    (t/is (nil? (:error out)))
    (t/is (= 0 (:texts-changed (first (:op-results (:result out))))))
    (t/is (nil? (:snapshot-id (:result out))))
    (t/is (empty? (snapshot-labels file-id)))))

(t/deftest the-lookup-is-built-only-for-a-call-with-replace-font
  (let [{:keys [profile file-id page-id custom-id]} (create-fixture)
        built (atom 0)
        orig  font-lookup/make-font-lookup]
    (with-redefs [font-lookup/make-font-lookup (fn [& args]
                                                 (swap! built inc)
                                                 (apply orig args))]
      (t/testing "a call with another operation builds none"
        (let [out (apply-ops! profile file-id [{:op "create_board" :page-id page-id :id "$tmp:b"
                                                :name "B" :x 0 :y 0 :width 10 :height 10}])]
          (t/is (nil? (:error out)))
          (t/is (= 0 @built))))
      (t/testing "a call with replace_font builds one"
        (let [out (apply-ops! profile file-id [(replace-op page-id "gfont-roboto" custom-id)])]
          (t/is (nil? (:error out)))
          (t/is (= 1 @built)))))))

(t/deftest team-fonts-are-read-only-for-a-team-font-target
  (let [{:keys [profile file-id page-id custom-id]} (create-fixture)
        reads (atom 0)
        orig  mcp-fonts/get-font-context]
    (with-redefs [mcp-fonts/get-font-context (fn [& args]
                                               (swap! reads inc)
                                               (apply orig args))]
      (let [out (apply-ops! profile file-id [(replace-op page-id "gfont-roboto" "sourcesanspro"
                                                         :variant-match "nearest")])]
        (t/is (nil? (:error out)))
        (t/is (= 0 @reads)))
      (let [out (apply-ops! profile file-id [(replace-op page-id "sourcesanspro" custom-id
                                                         :variant-match "nearest")])]
        (t/is (nil? (:error out)))
        (t/is (= 1 @reads))))))

(t/deftest bundled-target-writes-the-family-not-the-display-name
  (let [{:keys [profile file-id page-id t1]} (create-fixture)
        out  (apply-ops! profile file-id [(replace-op page-id "gfont-roboto" "sourcesanspro")])
        leaf (first (leaves-of (stored-shape file-id page-id t1)))]
    (t/is (nil? (:error out)))
    (t/is (= "sourcesanspro" (:font-id leaf)))
    (t/is (= "sourcesanspro" (:font-family leaf)))
    (t/is (= "bold" (:font-variant-id leaf)))))

(t/deftest google-target-with-the-flag-off-is-refused
  (let [{:keys [profile file-id page-id t1]} (create-fixture)
        before (revn file-id)
        shape  (stored-shape file-id page-id t1)]
    (with-redefs [cf/flags (disj cf/flags :google-fonts-provider)]
      (let [out (apply-ops! profile file-id [(replace-op page-id "sourcesanspro" "gfont-roboto")])]
        (t/is (= :mcp-invalid-operation (:code (ex-data (:error out)))))
        (t/is (re-find #"google-fonts-disabled" (:hint (ex-data (:error out)))))))
    (t/is (= before (revn file-id)))
    (t/is (= shape (stored-shape file-id page-id t1)))))

(t/deftest exact-refusal-writes-nothing
  (let [{:keys [profile file-id page-id t1 custom-id]} (create-fixture)
        _      (th/update-file* {:file-id file-id
                                 :profile-id (:id profile)
                                 :revn (revn file-id)
                                 :changes [(add-text page-id (uuid/next) [(roboto-leaf "Light" "300")])]})
        before (revn file-id)
        shape  (stored-shape file-id page-id t1)
        out    (apply-ops! profile file-id [(replace-op page-id "gfont-roboto" custom-id)])]
    (t/is (= :mcp-invalid-operation (:code (ex-data (:error out)))))
    (t/is (re-find #"300 normal" (:hint (ex-data (:error out)))))
    (t/is (= before (revn file-id)))
    (t/is (= shape (stored-shape file-id page-id t1)))))

(t/deftest a-replayed-request-answers-with-the-op-result-of-the-first-answer
  (let [{:keys [profile file-id page-id t1 custom-id]} (create-fixture)
        request (uuid/next)
        ops     [(replace-op page-id "gfont-roboto" custom-id)]
        first-out  (apply-ops! profile file-id ops :request-id request)
        revn-after (revn file-id)
        shape      (stored-shape file-id page-id t1)
        replay     (apply-ops! profile file-id ops :request-id request)]
    (t/is (nil? (:error first-out)))
    (t/is (= 1 (count (:op-results (:result first-out)))))
    (t/is (nil? (:error replay)))
    (t/is (true? (:already-applied (:result replay))))
    (t/is (= 0 (:commits (:result replay))))
    ;; A replay used to answer without `op-results`. The record of the
    ;; request now keeps them, so the replay returns the first answer's.
    (t/is (= (:op-results (:result first-out)) (:op-results (:result replay))))
    (t/is (not (contains? (:result replay) :replay-truncated)))
    (t/is (= revn-after (revn file-id)))
    (t/is (= shape (stored-shape file-id page-id t1)))))

(t/deftest a-refusal-in-a-call-with-several-operations-writes-nothing
  (let [{:keys [profile file-id page-id t1 custom-id]} (create-fixture)
        _      (th/update-file* {:file-id file-id
                                 :profile-id (:id profile)
                                 :revn (revn file-id)
                                 :changes [(add-text page-id (uuid/next) [(roboto-leaf "Light" "300")])]})
        before (revn file-id)
        shape  (stored-shape file-id page-id t1)
        out    (apply-ops! profile file-id
                           [{:op "create_board" :page-id page-id :id "$tmp:b"
                             :name "B" :x 0 :y 0 :width 10 :height 10}
                            (replace-op page-id "gfont-roboto" custom-id)])]
    (t/is (= :mcp-invalid-operation (:code (ex-data (:error out)))))
    (t/is (= before (revn file-id)))
    (t/is (= shape (stored-shape file-id page-id t1)))
    (t/is (empty? (snapshot-labels file-id)))))

(t/deftest the-lookup-reads-the-catalogue-only-when-the-provider-is-on
  (let [listed (atom [])
        orig   mcp-fonts/get-font-listing]
    (with-redefs [mcp-fonts/get-font-listing (fn [ctx font-id source]
                                               (swap! listed conj source)
                                               (orig ctx font-id source))]
      (t/testing "provider off: a Google font is refused, and no listing is read"
        (t/is (= {:reason "google-fonts-disabled"}
                 (font-lookup/resolve-font {:google-on false} "gfont-roboto")))
        (t/is (empty? @listed)))
      (t/testing "provider on: family and the three variant keys"
        (let [font (font-lookup/resolve-font {:google-on true} "gfont-roboto")]
          (t/is (= "Roboto" (:family font)))
          (t/is (every? #(= #{:id :weight :style} (set (keys %))) (:variants font)))
          (t/is (some #(= "700" (:id %)) (:variants font)))))
      (t/testing "a bundled font gives the write family, not the display name"
        (let [font (font-lookup/resolve-font {:google-on false} "sourcesanspro")]
          (t/is (= "sourcesanspro" (:family font)))
          (t/is (some #(= "bold" (:id %)) (:variants font)))))
      (t/testing "the reasons of the report"
        (t/is (= {:reason "unknown-font-id"} (font-lookup/resolve-font {:google-on true} "nope")))
        (t/is (= {:reason "not-in-google-catalog"}
                 (font-lookup/resolve-font {:google-on true} "gfont-no-such-font-zzz")))
        (t/is (= {:reason "custom-font-not-in-team"}
                 (font-lookup/resolve-font {:google-on true :team-fonts {}} "custom-x")))))))

;; --- OVER HTTP

(defn- http-request
  "Posts `body` to the MCP method `method` with the bearer `token`."
  [token method body]
  ((#'http/router-handler (::http/router th/*system*))
   (th/make-dummy-request
    {:path (str "/api/main/methods/" method)
     :method :post
     :headers {"content-type" "application/json"
               "accept" "application/json"
               "x-client" "penpot-mcp"
               "authorization" (str "Token " token)}
     :body-bytes (json/encode body)})))

(t/deftest the-reply-keys-are-camel-case-over-http
  (let [{:keys [profile file-id page-id custom-id]} (create-fixture)
        _     (th/update-file* {:file-id file-id
                                :profile-id (:id profile)
                                :revn (revn file-id)
                                :changes [(add-text page-id (uuid/next) [(roboto-leaf "Tok" "700")]
                                                    :applied-tokens {:font-family "brand"}
                                                    :grow-type :auto-width)]})
        token (:token (db/tx-run! th/*system* access-token/create-access-token
                                  (:id profile) "MCP" nil "mcp"))
        resp  (http-request token "mcp-apply-operations"
                            {"fileId" (str file-id)
                             "dryRun" true
                             "operations" [{"op" "replace_font"
                                            "pageId" (str page-id)
                                            "fromFontId" "gfont-roboto"
                                            "toFontId" custom-id
                                            "variantMatch" "nearest"}]})
        out   (java.io.ByteArrayOutputStream.)
        _     (rcp/write-body-to-stream (::yres/body resp) nil out)
        body  (json/decode (str out))
        res   (first (get body "opResults"))]
    (t/is (= 200 (::yres/status resp)))
    (t/is (= "replace_font" (get res "op")))
    (t/is (= 2 (get res "textsChanged")))
    (t/is (= 2 (get res "layoutDropped")))
    (t/is (= 0 (get res "autoSizeTexts")))
    (t/testing "nested keys are camel case"
      (t/is (= "normal-700" (get-in res ["variantsUsed" 0 "to" "variantId"])))
      (t/is (= "700" (get-in res ["variantsUsed" 0 "from" "weight"])))
      (t/is (= 1 (get-in res ["skipped" "total"])))
      (t/is (= "font-token" (get-in res ["skipped" "byReason" 0 "reason"])))
      (t/is (= ["font-family"] (get-in res ["skipped" "items" 0 "detail" "tokens"])))
      (t/is (false? (get-in res ["skipped" "itemsTruncated"]))))))
