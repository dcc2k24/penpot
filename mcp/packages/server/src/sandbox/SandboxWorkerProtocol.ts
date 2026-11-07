import type { HostPrimitiveName, SandboxLimit, SandboxRuntimeOptions } from "./GuestRuntime";

/*
 * Messages between the main thread and a sandbox worker. This file holds only types and constants, so that the
 * worker entry can import it without the main-thread code.
 */

/** Guest function that stores the JSON text it is given as `storage`. Defined by {@link STORAGE_BRIDGE}. */
export const STORAGE_SETTER = "__setStorage";

/** Guest function that returns `storage` as JSON text, or an empty string when it cannot be saved. */
export const STORAGE_GETTER = "__getStorage";

/**
 * Guest source that defines the storage functions. It is evaluated after the prelude in every worker, so the
 * main thread can save `storage` before a worker is replaced and load it into the next one.
 */
export const STORAGE_BRIDGE =
    `function ${STORAGE_SETTER}(text) { storage = JSON.parse(text); return "ok"; }\n` +
    `function ${STORAGE_GETTER}() { ` +
    "var text; try { text = JSON.stringify(storage); } catch (error) { text = undefined; } " +
    'return text === undefined ? "" : text; }';

/** Most bytes of storage JSON that a worker saves. A larger storage keeps the previous saved copy. */
export const STORAGE_LIMIT_BYTES = 8 * 1024 * 1024;

/** CPU budget of the storage restore and read, in milliseconds, unless a worker runtime is given another. */
export const DEFAULT_STORAGE_BUDGET_MS = 2_000;

/**
 * Write grace inside the worker. The main thread owns the hard stop of a write, so the worker's own watchdog must
 * not cut one short. This is just under the largest timer delay.
 */
export const WORKER_WRITE_GRACE_MS = 2_000_000_000;

/** Data that the worker receives on start. */
export interface WorkerInit {
    /** Guest source evaluated once before the first call. */
    readonly prelude: string;
    /** Limits of the guest context. */
    readonly options: SandboxRuntimeOptions;
    /** CPU budget of the storage restore and read, in milliseconds. */
    readonly storageBudgetMs: number;
}

/** Call that the main thread sends to the worker. */
export interface WorkerInvoke {
    readonly type: "invoke";
    /** Id of the call, echoed in its result. */
    readonly id: number;
    readonly functionName: string;
    readonly args: readonly string[];
    readonly budgetMs: number;
    /** Wall-clock limit of the call, from the moment the worker starts it, in milliseconds. */
    readonly wallMs?: number;
    /** Storage as JSON text that the call starts with, when the main thread has one. */
    readonly storage?: string;
}

/** Answer of the main thread to a host call of the worker. */
export interface WorkerHostResult {
    readonly type: "host-result";
    /** Id of the host call that this answers. */
    readonly id: number;
    readonly ok: boolean;
    /** Answer text, when the host call succeeded. Checked by the worker. */
    readonly value?: unknown;
    /** Failure text, when the host call failed. */
    readonly message?: string;
}

/** Message that the main thread sends to the worker. */
export type WorkerRequest = WorkerInvoke | WorkerHostResult;

/** Error of a guest call, as the worker reports it. */
export interface WorkerError {
    readonly message: string;
    /** Whether the error came from the runtime, and so carries the fields below. */
    readonly runtime: boolean;
    readonly guestName?: string;
    readonly fatal: boolean;
    readonly limit?: SandboxLimit;
}

/** Message that the worker sends to the main thread. */
export type WorkerMessage =
    | { readonly type: "ready"; readonly memoryBytes: number }
    | { readonly type: "init-failed"; readonly message: string }
    | {
          readonly type: "host-call";
          readonly id: number;
          readonly name: HostPrimitiveName;
          readonly args: readonly (string | boolean)[];
      }
    | ResultMessage;

/** Answer of a guest call that succeeded or failed; the storage and the memory are reported in both cases. */
interface ResultBase {
    readonly type: "result";
    readonly id: number;
    /** Note for the caller, such as storage that was not saved. */
    readonly warning?: string;
    /**
     * Storage after the call: its JSON text; null when it cannot be saved (the worker keeps it live);
     * undefined when it was not read, because the runtime is no longer usable.
     */
    readonly storage: string | null | undefined;
    readonly memoryBytes: number;
    readonly poisoned: boolean;
}

/** Answer of a guest call that returned a string. */
export interface ResultOk extends ResultBase {
    readonly ok: true;
    readonly value: string;
}

/** Answer of a guest call that failed. */
export interface ResultFailed extends ResultBase {
    readonly ok: false;
    readonly error: WorkerError;
}

/** Answer of a guest call. */
export type ResultMessage = ResultOk | ResultFailed;
