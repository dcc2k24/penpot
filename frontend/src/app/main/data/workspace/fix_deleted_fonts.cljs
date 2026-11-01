;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.main.data.workspace.fix-deleted-fonts
  (:require
   [app.common.data.macros :as dm]
   [app.common.files.helpers :as cfh]
   [app.common.types.objects-hints :as ohints]
   [app.common.types.text :as txt]
   [app.main.data.changes :as dwc]
   [app.main.data.helpers :as dsh]
   [app.main.fonts :as fonts]
   [beicon.v2.core :as rx]
   [potok.v2.core :as ptk]))

;; This event will update the file so the texts with non existing
;; custom fonts try to be fixed. This can happen when:
;;
;; - Exporting/importing files to different teams or penpot instances
;; - Moving files from one team to another in the same instance
;; - Custom fonts are explicitly deleted in the team area

(defn- calculate-alternative-font-id
  [value]
  (let [fonts (deref fonts/fontsdb)]
    (reduce-kv (fn [_ _ font]
                 (if (= (:family font) value)
                   (reduced (:id font))
                   nil))
               nil
               fonts)))

(defn- has-invalid-font-family?
  [node]
  (let [fonts (deref fonts/fontsdb)
        font-family (:font-family node)]
    (and (some? font-family)
         (nil? (get fonts (:font-id node))))))

(defn- shape-has-invalid-font-family??
  [shape]
  (and (cfh/text-shape? shape)
       (some has-invalid-font-family?
             (txt/node-seq txt/is-text-node? (:content shape)))))

(defn- fix-deleted-font
  [node]
  (if-let [alternative-font-id (calculate-alternative-font-id (:font-family node))]
    (assoc node :font-id alternative-font-id)
    node))

(defn- fix-shape-content
  [shape]
  (txt/transform-nodes has-invalid-font-family? fix-deleted-font
                       (:content shape)))

(defn- fix-typography
  [typography]
  (if-let [alternative-font-id (calculate-alternative-font-id (:font-family typography))]
    (assoc typography :font-id alternative-font-id)
    typography))

(defn- generate-page-changes
  "Changes that fix the texts of `page` with deleted fonts, except the
  shapes in the `skip-ids` set."
  [{:keys [objects id]} skip-ids]
  (let [change-for
        (fn [changes shape-id shape]
          (if (and (not (contains? skip-ids shape-id))
                   (shape-has-invalid-font-family?? shape))
            (let [fixed-content (fix-shape-content shape)]
              (if (not= fixed-content (:content shape))
                (conj changes {:type :mod-obj
                               :id shape-id
                               :page-id id
                               :operations [{:type :set
                                             :attr :content
                                             :val fixed-content}
                                            {:type :set
                                             :attr :position-data
                                             :val nil}]})
                changes))
            changes))

        hints (ohints/hints objects)]

    (if (some? hints)
      ;; With hints, only the texts that use a font id missing from the
      ;; fonts db are read.
      (let [fontsdb (deref fonts/fontsdb)]
        (reduce (fn [changes shape-id]
                  (change-for changes shape-id (get objects shape-id)))
                []
                (ohints/select-ids objects hints
                                   #(some (fn [font-id] (nil? (get fontsdb font-id)))
                                          (get-in hints [:texts % :font-ids]))
                                   shape-has-invalid-font-family??)))
      (reduce-kv change-for [] objects))))

(defn- generate-library-changes
  [fdata]
  (reduce-kv (fn [changes _ typography]
               (if (has-invalid-font-family? typography)
                 (let [fixed-typography (fix-typography typography)]
                   (if (not= fixed-typography typography)
                     (conj changes {:type :mod-typography
                                    :typography fixed-typography})
                     changes))
                 changes))
             []
             (:typographies fdata)))

(defn fix-deleted-fonts-for-local-library
  "Looks the file local library for deleted fonts and emit changes if
  invalid but fixable typographyes found."
  [file-id]
  (ptk/reify ::fix-deleted-fonts-for-local-library
    ptk/WatchEvent
    (watch [it state _]
      (let [fdata (dsh/lookup-file-data state file-id)]
        (when-let [changes (-> (generate-library-changes fdata)
                               (not-empty))]
          (rx/of (dwc/commit-changes
                  {:origin it
                   :redo-changes changes
                   :undo-changes []
                   :save-undo? false
                   :ignore-wasm? true})))))))

;; FIXME: would be nice to not execute this code twice per page in the
;; same working session, maybe some local memoization can improve that

(defn- edited-shape-ids
  "Ids of the texts under edition: an open editor holds their content and
  would write the old font back over a fix."
  [state]
  (let [edition (dm/get-in state [:workspace-local :edition])]
    (cond-> (into #{} (keys (:workspace-editor-state state)))
      (some? edition) (conj edition))))

(defn fix-deleted-fonts-for-page
  "Looks the page texts for deleted fonts and emit changes if invalid
  but fixable fonts found. By default the changes are not written to
  WASM (`:ignore-wasm? true`), for when the page is not uploaded yet;
  pass `:ignore-wasm? false` when the page is already in WASM.

  All the fixed texts go in one commit. Texts under edition are skipped
  (see `edited-shape-ids`); they are fixed on the next page init."
  ([file-id page-id]
   (fix-deleted-fonts-for-page file-id page-id nil))
  ([file-id page-id {:keys [ignore-wasm?] :or {ignore-wasm? true}}]
   (ptk/reify ::fix-deleted-fonts-for-page
     ptk/WatchEvent
     (watch [it state _]
       (let [page (dsh/lookup-page state file-id page-id)]
         (when-let [changes (-> (generate-page-changes page (edited-shape-ids state))
                                (not-empty))]
           (rx/of (dwc/commit-changes
                   {:origin it
                    :redo-changes changes
                    :undo-changes []
                    :save-undo? false
                    :ignore-wasm? ignore-wasm?}))))))))
