;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.mcp-scope
  "Scopes carried by MCP access tokens.

  A scope is one of the `mcp:*` strings in the `perms` array of an
  `access_token` row. Tokens without any `mcp:*` entry (every token
  created before scopes existed, and every new token by default) hold
  `mcp:read` only. `mcp:write`, `mcp:manage` and `mcp:delete` each
  imply `mcp:read` and nothing else."
  (:require
   [app.common.exceptions :as ex]
   [clojure.string :as str]))

(def read-scope "mcp:read")
(def write-scope "mcp:write")
(def manage-scope "mcp:manage")
(def delete-scope "mcp:delete")

(def all-scopes
  #{read-scope write-scope manage-scope delete-scope})

(defn scope?
  [value]
  (contains? all-scopes value))

(defn effective-scopes
  "Set of scopes a token with `perms` holds. Any scope implies read."
  [perms]
  (let [scopes (into #{} (filter #(str/starts-with? % "mcp:")) perms)
        scopes (into #{} (filter scope?) scopes)]
    (if (empty? scopes)
      #{read-scope}
      (conj scopes read-scope))))

(defn granted?
  "Whether a token with `perms` may use a command that requires `scope`."
  [perms scope]
  (contains? (effective-scopes perms) scope))

(defn check-scope!
  "Raise an authorization error unless `perms` grant `scope`."
  [perms scope]
  (when-not (granted? perms scope)
    (ex/raise :type :authorization
              :code :mcp-scope-required
              :hint (str "the MCP token lacks the " scope " scope")
              :required scope
              :granted (vec (sort (effective-scopes perms))))))

(defn replace-scopes
  "Perms with every `mcp:*` entry replaced by `scopes`."
  [perms scopes]
  (-> (into [] (remove #(str/starts-with? % "mcp:")) perms)
      (into (sort (filter scope? scopes)))))
