;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns app.rpc.commands.mcp-limits
  "The size limits of an MCP write call. Kept apart from `mcp-write` so
  that `mcp-whoami` can report them without loading the write path."
  (:require
   [app.config :as cf]))

(def max-changes
  "The most raw changes one `mcp-apply-changes` call takes."
  2000)

(def max-operations
  "The most typed operations one `mcp-apply-operations` call takes."
  2000)

(def max-payload-bytes
  "The largest transit encoding of a call's payload, in bytes."
  (* 8 1024 1024))

(defn max-compiled-changes
  "The most changes one call may compile to. Read from the config key
  `:mcp-max-compiled-changes`; 100000 when the key is not set."
  []
  (cf/get :mcp-max-compiled-changes 100000))
