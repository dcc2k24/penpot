# Sandbox worker threads

Each guest runtime runs in a `worker_threads` worker. `PENPOT_MCP_SANDBOX_WORKERS=false` runs guests on the main thread instead; the default is `true`.

## Design

- `SandboxWorkerRuntime` (main thread) owns the worker. It serves host calls, holds the token, the backend, the write queue and the exporter, and watches each call.
- `SandboxWorkerThread` (worker) holds one in-process `SandboxRuntime` (QuickJS, asyncify build). A host call is a message: the worker posts `host-call` and awaits `host-result`. The worker's event loop is free while it waits, so the asyncify build stays and no `Atomics.wait` is needed.
- The main thread enforces the hard stops. It terminates the worker when a call runs past its wall-clock limit plus a grace period (longer while a write is in flight), or when the guest CPU time of the call passes the budgets plus 2 s. The budgets cover the script, the storage restore and the storage read: 3 s, plus 2 s each for the two storage phases, plus the 2 s grace. The in-worker interrupt and deadline stay the first line.
- When the watchdog gives up, the host stops the flush: no chunk that was not sent yet is sent. A chunk in flight still lands; the tool waits up to 10 s for it, so the totals in the error are final.
- Memory: the guest keeps its WebAssembly maximum (256 MB by default). The worker heap is capped at 512 MB with `resourceLimits.maxOldGenerationSizeMb`.
- Mode: `SandboxRuntime.create` reads `PENPOT_MCP_SANDBOX_WORKERS` once, at the first runtime, and logs the mode it chose. `SandboxRuntime.createInProcess` is the main-thread runtime.

## Storage

- `storage` lives in the worker. The worker reads it as JSON after each call and sends the text only when it changed.
- The main thread keeps the last text. When a token's runtime is replaced, the next runtime starts with that text. At most `PENPOT_MCP_SANDBOX_MAX_SESSIONS` saved copies are kept; the least recently used is dropped first.
- A text above 8 MB is not sent. The previous copy stays, and the call returns a `storageNotice`.
- A saved copy that cannot be restored is dropped. The call fails with a message that says so, and the next call starts with empty storage.
- The storage read and restore refuse host calls, so a `toJSON` or a getter cannot start one.
- Values that JSON cannot hold (`Map`, functions, cycles) stay in the worker while it lives, and are lost when it is terminated.

## Build

- The server bundle (`build:server`) has two esbuild entries, `src/index.ts` and `src/sandbox/SandboxWorkerThread.ts`, written to `dist/index.js` and `dist/SandboxWorkerThread.js`. `scripts/copy-resources.js` fails the build when the worker file is missing, and `SandboxWorkerBuild.test.ts` checks it when a build exists.
- `SandboxWorkerRuntime` resolves the worker file from one constant (`ENTRY_NAME`): `.ts` next to the sources under `tsx`, `.js` next to `dist/index.js` in a bundle. When the file is missing the runtime falls back to the main thread and logs one warning.
- From the sources (`tsx`) and from the bundle alike, guests run in workers.

## Sizing

- Each worker holds about 60 MB of resident memory when idle.
- Each runtime's WebAssembly memory grows to at most 256 MB, and a runtime above 128 MB is dropped when it is idle.
- The default is `PENPOT_MCP_SANDBOX_MAX_SESSIONS=20`. 20 idle workers take about 1.2 GB; in the worst case, all 20 busy at their maximum, about 6.3 GB. A server with less memory should lower the limit.

## Start-up

- A worker takes about half a second to start under `tsx`, against about 70 ms for an in-process runtime. A token keeps its worker between calls.
- A small facade call costs about 0.7 ms in a worker, against about 0.04 ms in process.
