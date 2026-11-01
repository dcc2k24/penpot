;; This Source Code Form is subject to the terms of the Mozilla Public
;; License, v. 2.0. If a copy of the MPL was not distributed with this
;; file, You can obtain one at http://mozilla.org/MPL/2.0/.
;;
;; Copyright (c) KALEIDOS SUBSIDIARY SL

(ns frontend-tests.render-wasm.heap-growth-test
  "Writes into WASM memory must use a view taken after the allocation. When
   the memory grows, the old ArrayBuffer is detached and every view taken
   before the growth stops seeing the writes."
  (:require
   [app.common.render-wasm.api.props :as props]
   [app.common.render-wasm.wasm :as wasm]
   [cljs.test :as t :include-macros true]))

(def ^:private initial-capacity 8)

(defn- make-fake-module
  "A stand-in for the WASM module. Its `_alloc_bytes` grows the memory the
   way `memory.grow` does: the old buffer is transferred (copied and
   detached) into a bigger one, and the HEAP* views are replaced by views
   over the new buffer. Returns the module and an atom holding the offset of
   the last allocation."
  []
  (let [module     #js {}
        bump       (atom 0)
        last-alloc (atom nil)
        use-buffer! (fn [buffer]
                      (unchecked-set module "HEAPU8" (js/Uint8Array. buffer))
                      (unchecked-set module "HEAPU32" (js/Uint32Array. buffer))
                      (unchecked-set module "HEAP32" (js/Int32Array. buffer))
                      (unchecked-set module "HEAPF32" (js/Float32Array. buffer)))]
    (use-buffer! (js/ArrayBuffer. initial-capacity))
    (unchecked-set module "_alloc_bytes"
                   (fn [size]
                     (let [offset (deref bump)
                           end    (+ offset size)
                           old    (.-buffer (unchecked-get module "HEAPU8"))]
                       (when (> end (.-byteLength old))
                         (use-buffer! (.transfer old (* 2 end))))
                       (reset! bump end)
                       (reset! last-alloc offset)
                       offset)))
    (unchecked-set module "_start_shape_path_buffer" (fn [] nil))
    (unchecked-set module "_set_shape_path_chunk_buffer" (fn [] nil))
    (unchecked-set module "_set_shape_path_buffer" (fn [] nil))
    {:module module :last-alloc last-alloc}))

(t/deftest upload-path-bytes-writes-into-grown-memory
  (t/testing "path bytes land in the memory buffer that exists after the allocation"
    (let [{:keys [module last-alloc]} (make-fake-module)
          saved   wasm/internal-module
          payload (js/Uint8Array. #js [1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16])]
      (set! wasm/internal-module module)
      (try
        (props/upload-path-bytes! payload)
        (let [offset (deref last-alloc)
              heap   (unchecked-get module "HEAPU8")]
          (t/is (> (.-byteLength (.-buffer heap)) initial-capacity)
                "the allocation must have grown the memory for this test to mean anything")
          (t/is (= (vec (js/Array.from payload))
                   (vec (js/Array.from (.subarray heap offset (+ offset 16)))))
                "the bytes must be written into the current buffer"))
        (finally
          (set! wasm/internal-module saved))))))
