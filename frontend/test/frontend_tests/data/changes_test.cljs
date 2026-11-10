;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.data.changes-test
  "Tests for the commit event of `app.main.data.changes`: the rebase
  sent to the worker index. The pure helper is checked directly, and the
  commit event is checked through a store with a mocked worker."
  (:require
   [app.common.types.shape :as cts]
   [app.common.uuid :as uuid]
   [app.main.data.changes :as dch]
   [app.main.worker :as mw]
   [beicon.v2.core :as rx]
   [cljs.test :as t :include-macros true]
   [frontend-tests.helpers.async :as async]
   [frontend-tests.helpers.mock :as mock]
   [potok.v2.core :as ptk]))

(defn- set-x
  "A change that sets the x of the rectangle `shape-id` on `page-id`."
  [page-id shape-id x]
  {:type :mod-obj
   :page-id page-id
   :id shape-id
   :operations [{:type :set :attr :x :val x}]})

(defn- rebase-state
  "Test state: one page with a rectangle, and the save state `persistence`
  (nil when nothing is pending)."
  [file-id page-id shape-id persistence]
  {:current-file-id file-id
   :permissions {:can-edit true}
   :persistence persistence
   :files {file-id {:id file-id
                    :revn 0
                    :vern 0
                    :data {:pages [page-id]
                           :pages-index
                           {page-id {:id page-id
                                     :name "Page"
                                     :objects
                                     {uuid/zero
                                      (cts/setup-shape {:id uuid/zero :type :frame})

                                      shape-id
                                      (cts/setup-shape {:id shape-id :type :rect :x 0 :y 0})}}}}}}})

;; Scenario: a remote commit arrives while one queued and one buffered local
;; commit are pending. Proves: the worker gets one index update for the page,
;; and its changes follow the rebase order: undo of the buffered commit, undo
;; of the queued commit, the remote redo, then redo of the queued and the
;; buffered commits.
(t/deftest ^:async remote-commit-with-pending-edits-sends-one-index-update
  (let [file-id  (uuid/next)
        page-id  (uuid/next)
        shape-id (uuid/next)
        queued   {:id (uuid/next)
                  :file-id file-id
                  :undo-changes [(set-x page-id shape-id 10)]
                  :redo-changes [(set-x page-id shape-id 11)]}
        buffered {:id (uuid/next)
                  :file-id file-id
                  :undo-changes [(set-x page-id shape-id 20)]
                  :redo-changes [(set-x page-id shape-id 21)]}
        remote   (set-x page-id shape-id 30)
        persist  {:queue (into #queue [] [(:id queued)])
                  :index {(:id queued) queued}
                  :buffer [buffered]}
        messages (atom [])
        store    (ptk/store {:state (rebase-state file-id page-id shape-id persist)
                             :on-error #(t/is false (str %))})]
    (await
     (mock/with-mocks*
       {mw/ask! (mock/stub (fn [message]
                             (swap! messages conj message)
                             (rx/empty)))}
       (ptk/emit! store (dch/commit {:file-id file-id
                                     :file-revn 1
                                     :file-vern 0
                                     :save-undo? false
                                     :source :remote
                                     :redo-changes [remote]
                                     :undo-changes []}))
       (await (async/wait-for #(= 1 (count @messages)) "the index update is sent"))
       (await (async/settle))
       (t/is (= 1 (count @messages)) "one update, no second one for the rebase")
       (let [[message] @messages]
         (t/is (= :index/update (:cmd message)))
         (t/is (= page-id (:page-id message)))
         (t/is (= [(set-x page-id shape-id 20)
                   (set-x page-id shape-id 10)
                   remote
                   (set-x page-id shape-id 11)
                   (set-x page-id shape-id 21)]
                  (:changes message))))))))

;; Scenario: a remote commit arrives with nothing pending. Proves: the worker
;; gets one index update with the remote changes only.
(t/deftest ^:async remote-commit-without-pending-edits-sends-its-changes
  (let [file-id  (uuid/next)
        page-id  (uuid/next)
        shape-id (uuid/next)
        remote   (set-x page-id shape-id 30)
        messages (atom [])
        store    (ptk/store {:state (rebase-state file-id page-id shape-id nil)
                             :on-error #(t/is false (str %))})]
    (await
     (mock/with-mocks*
       {mw/ask! (mock/stub (fn [message]
                             (swap! messages conj message)
                             (rx/empty)))}
       (ptk/emit! store (dch/commit {:file-id file-id
                                     :file-revn 1
                                     :file-vern 0
                                     :save-undo? false
                                     :source :remote
                                     :redo-changes [remote]
                                     :undo-changes []}))
       (await (async/wait-for #(= 1 (count @messages)) "the index update is sent"))
       (await (async/settle))
       (t/is (= 1 (count @messages)) "one update, no second one")
       (t/is (= [remote] (:changes (first @messages))))))))

;; Scenario: a local commit is made while a queued commit is pending. Proves:
;; a local commit does not rebase, so the worker gets one index update with
;; only the redo changes of the local commit.
(t/deftest ^:async local-commit-sends-only-its-redo-changes
  (let [file-id  (uuid/next)
        page-id  (uuid/next)
        shape-id (uuid/next)
        queued   {:id (uuid/next)
                  :file-id file-id
                  :undo-changes [(set-x page-id shape-id 10)]
                  :redo-changes [(set-x page-id shape-id 11)]}
        persist  {:queue (into #queue [] [(:id queued)])
                  :index {(:id queued) queued}}
        local    (set-x page-id shape-id 40)
        messages (atom [])
        store    (ptk/store {:state (rebase-state file-id page-id shape-id persist)
                             :on-error #(t/is false (str %))})]
    (await
     (mock/with-mocks*
       {mw/ask! (mock/stub (fn [message]
                             (swap! messages conj message)
                             (rx/empty)))}
       (ptk/emit! store (dch/commit {:file-id file-id
                                     :file-revn 1
                                     :file-vern 0
                                     :save-undo? false
                                     :source :local
                                     :redo-changes [local]
                                     :undo-changes []}))
       (await (async/wait-for #(= 1 (count @messages)) "the index update is sent"))
       (await (async/settle))
       (t/is (= 1 (count @messages)) "one update, no second one")
       (t/is (= [local] (:changes (first @messages))))))))

;; Scenario: a remote commit with two pending commits, given in commit order.
;; Proves: the undo changes of the pending commits come latest first, each
;; keeping its own order, and the redo changes come after the remote redo.
(t/deftest rebase-changes-undo-pending-latest-first-then-redo-in-commit-order
  (let [c1 {:undo-changes [:u1a :u1b] :redo-changes [:r1]}
        c2 {:undo-changes [:u2] :redo-changes [:r2]}
        r  {:redo-changes [:rr]}]
    (t/is (= [:u2 :u1a :u1b :rr :r1 :r2]
             (#'dch/get-rebase-changes r [c1 c2])))))

;; Scenario: a remote commit with nothing pending. Proves: the rebase has
;; nothing to undo or redo, so the changes are the redo changes of the commit.
(t/deftest rebase-changes-without-pending-are-the-commit-redo-changes
  (t/is (= [:rr]
           (#'dch/get-rebase-changes {:redo-changes [:rr]} nil))))
