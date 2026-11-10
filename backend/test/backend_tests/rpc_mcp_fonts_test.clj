;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns backend-tests.rpc-mcp-fonts-test
  (:require
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.config :as cf]
   [app.db :as db]
   [app.http.access-token :as-alias actoken]
   [app.rpc :as-alias rpc]
   [app.rpc.commands.mcp :as mcp]
   [app.rpc.mcp-fonts :as mcp-fonts]
   [app.util.cache :as cache]
   [backend-tests.helpers :as th]
   [clojure.test :as t]))

(t/use-fixtures :once (t/compose-fixtures
                       (partial th/init-config [:enable-access-tokens
                                                :enable-client-header-check-middleware])
                       th/init-system))

(defn- clear-mcp-caches
  "Empties the MCP caches between tests. Test files reuse the same file
  ids, so a usage cached by one test would answer for another test's file."
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
  "Runs an MCP read command as `profile`, authenticated with an MCP token
  of `perms`. `token-id` is passed as the id of the request's token."
  [profile method params & {:keys [perms token-id]}]
  (let [data (merge {::th/type method
                     ::rpc/profile-id (:id profile)
                     ::rpc/auth-type :token
                     ::rpc/token-type "mcp"
                     ::rpc/token-perms (or perms #{})}
                    params)]
    (th/command!
     (cond-> data
       (some? token-id)
       (vary-meta assoc :app.http/request
                  {:headers {}
                   ::actoken/id token-id})))))

(defn- current-revn
  [file-id]
  (:revn (th/db-get :file {:id file-id})))

(defn- apply-changes!
  [profile file-id changes]
  (th/update-file* {:file-id file-id
                    :profile-id (:id profile)
                    :revn (current-revn file-id)
                    :changes changes}))

(defn- add-obj
  [page-id id parent-id frame-id attrs]
  {:type :add-obj
   :page-id page-id
   :id id
   :parent-id parent-id
   :frame-id frame-id
   :obj (cts/setup-shape (merge {:id id
                                 :parent-id parent-id
                                 :frame-id frame-id}
                                attrs))})

(defn- run
  "A text run with the attributes `attrs` over the default ones."
  [attrs]
  (merge {:text "Hi"
          :font-size "14"
          :font-family "sourcesanspro"
          :font-weight "400"
          :font-style "normal"
          :fills [{:fill-color "#000000" :fill-opacity 1}]}
         attrs))

(defn- text-content
  "The content of a text shape with one paragraph of the runs `runs`."
  [runs]
  {:type "root"
   :children [{:type "paragraph-set"
               :children [{:type "paragraph"
                           :children (mapv run runs)}]}]})

(defn- insert-storage!
  "A stored object for a font file, and its id."
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

(defn- insert-font-row!
  "A live team font variant of `team-id` for the font uuid `font-id`, with the
  file attributes `attrs` over a regular 400 variant."
  [team-id font-id attrs]
  (db/insert! th/*pool* :team-font-variant
              (merge {:id (uuid/next)
                      :team-id team-id
                      :font-id font-id
                      :font-family "Brand"
                      :font-weight 400
                      :font-style "normal"
                      :variant-name "Regular"}
                     attrs)))

(defn- insert-team-font!
  "A live team font variant of `team-id` for `font-id`, with a stored TTF."
  [team-id font-id ttf-id]
  (insert-font-row! team-id font-id {:ttf-file-id ttf-id}))

(defn- create-fixture
  "A file with three pages. Page one holds a board with two text shapes that
  use the builtin family, a Google family and a made-up Google id. Page two
  holds a board with a text shape that uses a custom font the team has, a
  custom font it lacks, and an id with no known prefix. Page three is empty.
  The team owns the custom font `owned`, with a TTF file."
  []
  (let [profile  (th/create-profile* 1 {:is-active true})
        file     (th/create-file* 1 {:profile-id (:id profile)
                                     :project-id (:default-project-id profile)})
        team-id  (:team-id (th/db-get :project {:id (:default-project-id profile)}))
        page1    (get-in file [:data :pages 0])
        page2    (uuid/next)
        page3    (uuid/next)
        board1   (uuid/next)
        text-a   (uuid/next)
        text-b   (uuid/next)
        board2   (uuid/next)
        text-c   (uuid/next)
        owned    (uuid/next)
        lacking  (uuid/next)
        owned-id (str "custom-" owned)
        lack-id  (str "custom-" lacking)
        ttf      (insert-storage!)]
    (insert-team-font! team-id owned ttf)
    (apply-changes!
     profile (:id file)
     [{:type :add-page :id page2 :name "Second"}
      {:type :add-page :id page3 :name "Third"}
      (add-obj page1 board1 uuid/zero uuid/zero {:type :frame :name "Board"})
      (add-obj page1 text-a board1 board1
               {:type :text :name "Text A" :x 0 :y 0 :width 100 :height 20
                :content (text-content [{:font-id "sourcesanspro"
                                         :font-variant-id "regular"}
                                        {:font-id "gfont-roboto"
                                         :font-variant-id "regular"
                                         :font-family "Roboto"}])})
      (add-obj page1 text-b board1 board1
               {:type :text :name "Text B" :x 0 :y 0 :width 100 :height 20
                :content (text-content [{:font-id "gfont-roboto"
                                         :font-variant-id "regular"
                                         :font-family "Roboto"}
                                        {:font-id "gfont-roboto"
                                         :font-variant-id "700"
                                         :font-family "Roboto"
                                         :font-weight "700"}
                                        {:font-id "gfont-not-a-real-font"
                                         :font-family "Nope"}])})
      (add-obj page2 board2 uuid/zero uuid/zero {:type :frame :name "Board"})
      (add-obj page2 text-c board2 board2
               {:type :text :name "Text C" :x 0 :y 0 :width 100 :height 20
                :content (text-content [{:font-id owned-id
                                         :font-variant-id "normal-400"
                                         :font-family "Brand"}
                                        {:font-id owned-id
                                         :font-variant-id "normal-700"
                                         :font-family "Brand"
                                         :font-weight "700"}
                                        {:font-id lack-id
                                         :font-variant-id "normal-400"
                                         :font-family "Lacking"}
                                        {:font-id "zzz-unknown"
                                         :font-family "Mystery"}])})])
    {:profile (th/db-get :profile {:id (:id profile)})
     :file-id (:id file)
     :team-id team-id
     :page1 page1
     :page2 page2
     :page3 page3
     :board1 board1
     :text-a text-a
     :text-b text-b
     :owned owned
     :owned-id owned-id
     :lacking lacking
     :lack-id lack-id
     :ttf ttf}))

(defn- create-runs-file!
  "A file of profile `i` with one board holding one text shape whose runs are
  `runs` (attribute maps over the default run). Returns the profile, the file
  id and its team id."
  [i runs]
  (let [profile (th/create-profile* i {:is-active true})
        file    (th/create-file* i {:profile-id (:id profile)
                                    :project-id (:default-project-id profile)})
        team-id (:team-id (th/db-get :project {:id (:default-project-id profile)}))
        page    (get-in file [:data :pages 0])
        board   (uuid/next)
        text    (uuid/next)]
    (apply-changes!
     profile (:id file)
     [(add-obj page board uuid/zero uuid/zero {:type :frame :name "Board"})
      (add-obj page text board board
               {:type :text :name "Text" :x 0 :y 0 :width 100 :height 20
                :content (text-content runs)})])
    {:profile profile
     :file-id (:id file)
     :team-id team-id}))

(defn- get-fonts
  [profile file-id & params]
  (call! profile :get-mcp-fonts (apply hash-map :file-id file-id params)))

(defn- font-of
  "The report of font `font-id` in the reply `out`."
  [out font-id]
  (first (filter #(= font-id (:font-id %)) (:fonts (:result out)))))

(defn- variant-of
  [font variant-id]
  (first (filter #(= variant-id (:variant-id %)) (:variants font))))

(defn- audit-props
  [out]
  (:app.loggers.audit/replace-props (meta (:result out))))

;; --- REPORT

(t/deftest fonts-report-each-source-and-resolution
  (let [{:keys [profile file-id owned-id lack-id]} (create-fixture)
        out (get-fonts profile file-id)]
    (t/is (nil? (:error out)))
    (t/is (= #{:revn :fonts :unresolved :truncated} (set (keys (:result out)))))
    (t/is (= (current-revn file-id) (:revn (:result out))))
    (t/is (false? (:truncated (:result out))))

    (let [builtin (font-of out "sourcesanspro")
          google  (font-of out "gfont-roboto")
          absent  (font-of out "gfont-not-a-real-font")
          owned   (font-of out owned-id)
          lacking (font-of out lack-id)
          unknown (font-of out "zzz-unknown")]
      (t/is (= :builtin (:source builtin)))
      (t/is (true? (:resolved builtin)))
      (t/is (not (contains? builtin :reason)))

      (t/is (= :google (:source google)))
      (t/is (true? (:resolved google)))
      (t/is (= "Roboto" (:family google)))

      (t/is (= :google (:source absent)))
      (t/is (false? (:resolved absent)))
      (t/is (= "not-in-google-catalog" (:reason absent)))

      (t/is (= :custom (:source owned)))
      (t/is (true? (:resolved owned)))

      (t/is (= :custom (:source lacking)))
      (t/is (false? (:resolved lacking)))
      (t/is (= "custom-font-not-in-team" (:reason lacking)))

      (t/is (= :unknown (:source unknown)))
      (t/is (false? (:resolved unknown)))
      (t/is (= "unknown-font-id" (:reason unknown)))

      (t/is (= 3 (:unresolved (:result out)))))))

(t/deftest fonts-count-runs-shapes-and-pages
  (let [{:keys [profile file-id page1 page2 owned-id lack-id]} (create-fixture)
        out    (get-fonts profile file-id)
        fonts  (:fonts (:result out))
        google (font-of out "gfont-roboto")
        owned  (font-of out owned-id)]
    ;; roboto: three runs over two shapes, all on page one
    (t/is (= 3 (:runs google)))
    (t/is (= 2 (:shapes google)))
    (t/is (= [{:page-id page1 :runs 3}] (:pages google)))
    (t/is (= 1 (:runs (font-of out "sourcesanspro"))))
    (t/is (= [{:page-id page2 :runs 2}] (:pages owned)))
    (t/is (= 2 (:runs owned)))
    (t/is (= 1 (:shapes owned)))
    ;; sorted by runs, descending, then by font id
    (t/is (= [3 2 1 1 1 1] (map :runs fonts)))
    (t/is (= ["gfont-roboto" owned-id]
             (take 2 (map :font-id fonts))))
    (t/is (= [lack-id "gfont-not-a-real-font" "sourcesanspro" "zzz-unknown"]
             (drop 2 (map :font-id fonts))))))

(t/deftest fonts-variants-carry-their-urls
  (let [{:keys [profile file-id owned-id ttf]} (create-fixture)
        out     (get-fonts profile file-id)
        google  (font-of out "gfont-roboto")
        owned   (font-of out owned-id)
        regular (variant-of google "regular")]
    (t/is (true? (:resolved regular)))
    (t/is (.startsWith ^String (:url regular) "https://fonts.gstatic.com/"))
    (t/is (= "700" (:variant-id (variant-of google "700"))))
    (t/is (true? (:resolved (variant-of google "700"))))
    (t/is (= (str (cf/get :public-uri) "/assets/by-id/" ttf)
             (:url (variant-of owned "normal-400"))))))

(t/deftest variant-the-font-lacks-is-not-found-while-the-font-resolves
  (let [{:keys [profile file-id owned-id]} (create-fixture)
        out   (get-fonts profile file-id)
        owned (font-of out owned-id)
        v     (variant-of owned "normal-700")]
    (t/is (true? (:resolved owned)))
    (t/is (false? (:resolved v)))
    (t/is (= "variant-not-found" (:reason v)))
    (t/is (= 1 (:runs v)))))

(t/deftest google-fonts-off-refuses-catalogue-fonts
  (let [{:keys [profile file-id]} (create-fixture)]
    (with-redefs [cf/flags (disj cf/flags :google-fonts-provider)]
      (let [out    (get-fonts profile file-id)
            google (font-of out "gfont-roboto")]
        (t/is (false? (:resolved google)))
        (t/is (= "google-fonts-disabled" (:reason google)))
        (t/is (every? #(= "google-fonts-disabled" (:reason %)) (:variants google)))
        (t/is (every? #(nil? (:url %)) (:variants google)))
        (t/is (true? (:resolved (font-of out "sourcesanspro"))))))))

(t/deftest resolution-is-read-on-every-call
  ;; the usage of a page is cached, the resolution is not: a flag or a team
  ;; font that changes between two calls shows in the second answer
  (let [{:keys [profile file-id team-id lacking lack-id]} (create-fixture)]
    (t/is (true? (:resolved (font-of (get-fonts profile file-id) "gfont-roboto"))))
    (with-redefs [cf/flags (disj cf/flags :google-fonts-provider)]
      (let [out (get-fonts profile file-id)]
        (t/is (= "google-fonts-disabled" (:reason (font-of out "gfont-roboto"))))))
    (t/is (true? (:resolved (font-of (get-fonts profile file-id) "gfont-roboto"))))
    (t/is (false? (:resolved (font-of (get-fonts profile file-id) lack-id))))
    (insert-team-font! team-id lacking (insert-storage!))
    (t/is (true? (:resolved (font-of (get-fonts profile file-id) lack-id))))))

(t/deftest root-ids-limit-the-report-to-those-subtrees
  (let [{:keys [profile file-id page1 board1 text-b]} (create-fixture)
        out    (get-fonts profile file-id :page-id page1 :root-ids [text-b])
        fonts  (:fonts (:result out))
        google (font-of out "gfont-roboto")]
    (t/is (nil? (:error out)))
    (t/is (= ["gfont-roboto" "gfont-not-a-real-font"] (map :font-id fonts)))
    (t/is (= 2 (:runs google)))
    (t/is (= 1 (:shapes google)))
    (t/is (= [page1] (map :page-id (:pages google))))
    (t/is (= [page1] (:page-ids (audit-props out))))

    ;; a root and its own descendant are walked once: the runs do not double
    (let [nested (get-fonts profile file-id :page-id page1 :root-ids [board1 text-b])
          whole  (get-fonts profile file-id :page-id page1 :root-ids [board1])]
      (t/is (= (:fonts (:result whole)) (:fonts (:result nested)))))))

(t/deftest subtree-ids-walk-every-shape-once
  (let [a       (uuid/next)
        b       (uuid/next)
        c       (uuid/next)
        objects {a {:shapes [b c]}
                 b {:shapes [c]}
                 c {:shapes [a]}}]
    ;; a cycle in :shapes terminates, and a shape reached twice is kept once
    (t/is (= #{a b c} (mcp-fonts/get-subtree-ids objects [a])))
    (t/is (= #{a b c} (mcp-fonts/get-subtree-ids objects [a b c])))
    ;; b reaches c, and c reaches a through the cycle
    (t/is (= #{a b c} (mcp-fonts/get-subtree-ids objects [b])))
    (t/is (= #{b c} (mcp-fonts/get-subtree-ids {b {:shapes [c]} c {:shapes []}} [b])))))

(t/deftest root-ids-need-a-page
  (let [{:keys [profile file-id text-a]} (create-fixture)
        out (get-fonts profile file-id :root-ids [text-a])]
    (t/is (= :validation (th/ex-type (:error out))))))

(t/deftest root-ids-missing-on-the-page-are-refused
  (let [{:keys [profile file-id page2 text-a]} (create-fixture)
        out (get-fonts profile file-id :page-id page2 :root-ids [text-a])]
    (t/is (= :shape-not-found (th/ex-code (:error out))))))

(t/deftest zero-budget-scan-is-truncated
  (let [{:keys [profile file-id page1 owned-id]} (create-fixture)]
    (with-redefs [mcp-fonts/scan-budget-ns 0]
      (let [out (get-fonts profile file-id)]
        (t/is (true? (:truncated (:result out))))
        ;; the first page is always read, the others are not
        (t/is (= [page1] (map :page-id (:pages (font-of out "gfont-roboto")))))
        (t/is (nil? (font-of out owned-id)))))))

(t/deftest second-call-covers-the-pages-the-first-missed
  (let [{:keys [profile file-id page1 page2 owned-id]} (create-fixture)
        scans (atom 0)
        original @#'mcp-fonts/get-objects-usage]
    (with-redefs [mcp-fonts/scan-budget-ns 0
                  mcp-fonts/get-objects-usage (fn [& args]
                                                (swap! scans inc)
                                                (apply original args))]
      (let [first-out  (get-fonts profile file-id)
            _          (t/is (true? (:truncated (:result first-out))))
            _          (t/is (= [page1] (:page-ids (audit-props first-out))))
            _          (t/is (= 1 @scans))
            second-out (get-fonts profile file-id)]
        (t/is (true? (:truncated (:result second-out))))
        (t/is (= 2 @scans))
        ;; page one comes from the cache, page two is new
        (t/is (some? (font-of second-out owned-id)))
        (t/is (= [page1 page2] (:page-ids (audit-props second-out))))))))

(t/deftest the-font-of-another-team-does-not-resolve-or-leak-its-url
  (let [{:keys [profile team-id]} (create-fixture)
        other-font (uuid/next)
        other-team (th/create-team* 77 {:profile-id (:id profile)})
        other-ttf  (insert-storage!)
        _          (insert-team-font! (:id other-team) other-font other-ttf)
        file       (create-runs-file! 2 [{:font-id (str "custom-" other-font)
                                          :font-variant-id "normal-400"}])
        out        (get-fonts (:profile file) (:file-id file))
        font       (font-of out (str "custom-" other-font))]
    (t/is (not= team-id (:team-id file)) "the fixture files stay on their own team")
    (t/is (false? (:resolved font)))
    (t/is (= "custom-font-not-in-team" (:reason font)))
    (t/is (not (contains? (variant-of font "normal-400") :url)))
    (t/is (not (.contains ^String (pr-str out) (str other-ttf))))))

(t/deftest leaf-without-font-id-counts-as-the-default-font
  (let [{:keys [profile file-id]} (create-runs-file!
                                   3 [{:text "no font id"}])
        out (get-fonts profile file-id)
        font (font-of out "sourcesanspro")]
    (t/is (= 1 (:runs font)))
    (t/is (true? (:resolved font)))))

(t/deftest runs-of-one-face-merge-into-one-variant
  (let [{:keys [profile file-id]}
        (create-runs-file! 4 [{:font-id "gfont-roboto" :font-variant-id "regular"
                               :font-family "Roboto"}
                              ;; no variant id: matched to "regular" by weight and style
                              {:font-id "gfont-roboto" :font-family "Roboto"}
                              {:font-id "gfont-roboto" :font-family "Roboto"
                               :font-weight "700"}
                              ;; no catalogue face at this weight
                              {:font-id "gfont-roboto" :font-family "Roboto"
                               :font-weight "1000"}])
        out    (get-fonts profile file-id)
        roboto (font-of out "gfont-roboto")
        ids    (map :variant-id (:variants roboto))]
    (t/is (= ["700" "normal-1000" "regular"] (vec ids)))
    (t/is (= 2 (:runs (variant-of roboto "regular"))))
    (t/is (true? (:resolved (variant-of roboto "regular"))))
    (t/is (= 1 (:runs (variant-of roboto "700"))))
    (let [missing (variant-of roboto "normal-1000")]
      (t/is (false? (:resolved missing)))
      (t/is (= "variant-not-found" (:reason missing))))))

(t/deftest empty-text-leaves-are-not-runs
  (let [{:keys [profile file-id]}
        (create-runs-file! 5 [{:text "" :font-id "gfont-roboto"}
                              {:font-id "sourcesanspro"}])
        out (get-fonts profile file-id)]
    (t/is (nil? (font-of out "gfont-roboto")))
    (t/is (= 1 (:runs (font-of out "sourcesanspro"))))
    (t/is (zero? (:unresolved (:result out))))))

(t/deftest custom-url-falls-back-to-the-stored-file
  (let [otf-font   (uuid/next)
        woff2-font (uuid/next)
        woff1-font (uuid/next)
        otf-file   (insert-storage!)
        woff2-file (insert-storage!)
        woff1-file (insert-storage!)
        base       (cf/get :public-uri)
        {:keys [profile file-id team-id]}
        (create-runs-file! 6 [{:font-id (str "custom-" otf-font) :font-variant-id "normal-400"}
                              {:font-id (str "custom-" woff2-font) :font-variant-id "normal-400"}
                              {:font-id (str "custom-" woff1-font) :font-variant-id "normal-400"}])]
    (insert-font-row! team-id otf-font {:otf-file-id otf-file})
    (insert-font-row! team-id woff2-font {:woff2-file-id woff2-file})
    (insert-font-row! team-id woff1-font {:woff1-file-id woff1-file})
    (let [out (get-fonts profile file-id)]
      (t/is (= (str base "/assets/by-id/" otf-file)
               (:url (variant-of (font-of out (str "custom-" otf-font)) "normal-400"))))
      (t/is (= (str base "/assets/by-id/" woff2-file)
               (:url (variant-of (font-of out (str "custom-" woff2-font)) "normal-400"))))
      (t/is (= (str base "/assets/by-id/" woff1-file)
               (:url (variant-of (font-of out (str "custom-" woff1-font)) "normal-400")))))))

(t/deftest many-fonts-are-capped-and-the-reply-stays-in-budget
  (let [runs (mapv (fn [i] {:font-id (str "zz-font-" i)}) (range 501))
        {:keys [profile file-id]} (create-runs-file! 7 runs)
        out (get-fonts profile file-id)]
    (t/is (= 500 (count (:fonts (:result out)))))
    (t/is (= 501 (:unresolved (:result out))))
    (t/is (true? (:truncated (:result out))))
    (with-redefs [mcp/response-byte-budget 1]
      (let [small (get-fonts profile file-id)]
        (t/is (= 1 (count (:fonts (:result small)))))
        (t/is (true? (:truncated (:result small))))))))

;; --- OUTLINE

(t/deftest outline-warns-once-per-page-and-unresolved-font
  (let [{:keys [profile file-id page1 page2 owned-id lack-id]} (create-fixture)
        out      (call! profile :get-mcp-file-outline {:file-id file-id})
        warnings (:warnings (:result out))
        fonts    (set (map :font-id warnings))]
    (t/is (nil? (:error out)))
    (t/is (= 3 (count warnings)))
    (t/is (true? (:warnings-complete (:result out))))
    (t/is (false? (:warnings-truncated (:result out))))
    (t/is (every? #(= "font-unresolved" (:kind %)) warnings))
    (t/is (= #{"gfont-not-a-real-font" lack-id "zzz-unknown"} fonts))
    (t/is (not (contains? fonts "gfont-roboto")))
    (t/is (not (contains? fonts owned-id)))
    (t/is (= [page1 page2 page2]
             (map :page-id warnings)))
    (t/is (= #{"not-in-google-catalog" "custom-font-not-in-team" "unknown-font-id"}
             (set (map :reason warnings))))
    (t/is (every? #(= 1 (:runs %)) warnings))))

(t/deftest outline-pages-keep-their-keys
  (let [{:keys [profile file-id]} (create-fixture)
        pages (:pages (:result (call! profile :get-mcp-file-outline {:file-id file-id})))]
    (t/is (every? #(= #{:name :shape-count :root-child-count :id :index} (set (keys %)))
                  pages))))

(t/deftest outline-second-call-builds-no-page-summary
  (let [{:keys [profile file-id]} (create-fixture)
        builds   (atom 0)
        original @#'mcp/page-summary
        outline  #(call! profile :get-mcp-file-outline {:file-id file-id})]
    (with-redefs [mcp/page-summary (fn [& args]
                                     (swap! builds inc)
                                     (apply original args))]
      (t/is (nil? (:error (outline))))
      (t/is (= 3 @builds))
      (t/is (nil? (:error (outline))))
      (t/is (= 3 @builds)))))

(t/deftest outline-budget-covers-more-on-each-call
  (let [{:keys [profile file-id]} (create-fixture)
        scans   (atom 0)
        original @#'mcp-fonts/get-objects-usage
        outline #(:result (call! profile :get-mcp-file-outline {:file-id file-id}))]
    (with-redefs [mcp-fonts/outline-budget-ns 0
                  mcp-fonts/get-objects-usage (fn [& args]
                                                (swap! scans inc)
                                                (apply original args))]
      (let [first-out (outline)]
        (t/is (false? (:warnings-complete first-out)))
        (t/is (= 1 (count (:warnings first-out))))
        (t/is (= 1 @scans)))
      (let [second-out (outline)]
        (t/is (false? (:warnings-complete second-out)))
        (t/is (= 3 (count (:warnings second-out))))
        (t/is (= 2 @scans)))
      (let [third-out (outline)]
        (t/is (true? (:warnings-complete third-out)))
        (t/is (= 3 (count (:warnings third-out))))
        (t/is (= 3 @scans))))))

(t/deftest outline-caps-its-warnings-at-fifty
  (let [runs (mapv (fn [i] {:font-id (str "zz-font-" i)}) (range 60))
        {:keys [profile file-id]} (create-runs-file! 8 runs)
        out (:result (call! profile :get-mcp-file-outline {:file-id file-id}))]
    (t/is (= 50 (count (:warnings out))))
    (t/is (true? (:warnings-truncated out)))
    (t/is (true? (:warnings-complete out)))))

(t/deftest outline-leaves-a-large-page-until-get-mcp-fonts-reads-it
  (let [{:keys [profile file-id page1]} (create-fixture)
        scans    (atom 0)
        original @#'mcp-fonts/get-objects-usage
        outline  #(:result (call! profile :get-mcp-file-outline {:file-id file-id}))]
    (with-redefs [mcp-fonts/outline-max-shapes 2
                  mcp-fonts/get-objects-usage (fn [& args]
                                                (swap! scans inc)
                                                (apply original args))]
      ;; page one holds three shapes, above the bound: it is not scanned
      (let [first-out (outline)]
        (t/is (false? (:warnings-complete first-out)))
        (t/is (not-any? #(= page1 (:page-id %)) (:warnings first-out)))
        (t/is (= 2 @scans)))

      ;; get-mcp-fonts reads page one in full and caches it
      (t/is (nil? (:error (call! profile :get-mcp-fonts {:file-id file-id :page-id page1}))))
      (t/is (= 3 @scans))

      (let [second-out (outline)]
        (t/is (true? (:warnings-complete second-out)))
        (t/is (some #(= page1 (:page-id %)) (:warnings second-out)))
        (t/is (= 3 @scans))))))

;; --- ACCESS AND AUDIT

(t/deftest profile-without-access-is-refused
  (let [{:keys [file-id]} (create-fixture)
        outsider (th/create-profile* 2 {:is-active true})
        out      (get-fonts outsider file-id)]
    (t/is (= :not-found (th/ex-type (:error out))))))

(t/deftest audit-props-name-the-file-and-its-pages
  (let [{:keys [profile file-id page1 page2 page3]} (create-fixture)
        out   (get-fonts profile file-id)
        props (audit-props out)]
    (t/is (= "get-mcp-fonts" (:tool props)))
    (t/is (= file-id (:file-id props)))
    (t/is (= [page1 page2 page3] (:page-ids props)))))
