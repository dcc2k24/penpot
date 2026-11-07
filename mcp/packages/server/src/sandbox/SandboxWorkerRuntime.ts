import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
    DEFAULT_GUEST_MEMORY_BYTES,
    RUNTIME_DISCARDED_MESSAGE,
    SandboxRuntimeError,
    WALL_CLOCK_MESSAGE,
    WATCHDOG_GRACE_MS,
    WATCHDOG_WRITE_GRACE_MS,
    WRITE_PRIMITIVES,
    cpuLimitMessage,
    type GuestRuntime,
    type HostPrimitiveName,
    type InvokeOptions,
    type SandboxHostCalls,
    type SandboxRuntimeOptions,
} from "./GuestRuntime";
import type {
    ResultMessage,
    WorkerError,
    WorkerHostResult,
    WorkerInit,
    WorkerMessage,
    WorkerRequest,
} from "./SandboxWorkerProtocol";
import { DEFAULT_STORAGE_BUDGET_MS } from "./SandboxWorkerProtocol";

/** Timing of a worker runtime. The defaults are the production values; tests give smaller ones. */
export interface WorkerTiming {
    /** Guest CPU time past the budgets that the main thread allows before it terminates the worker, in milliseconds. */
    readonly cpuBackstopMs?: number;
    /** CPU budget of the storage restore and of the storage read, in milliseconds. */
    readonly storageBudgetMs?: number;
}

/** Message that the worker sends with a host call. */
type HostCallMessage = Extract<WorkerMessage, { type: "host-call" }>;

/** A call that the worker is running, with the bookkeeping of the watchdog. */
interface ActiveCall {
    /** Id of the call, matched with its result. */
    readonly id: number;
    /** Host that serves the host calls of the call. */
    readonly host: SandboxHostCalls;
    /** Guest CPU time the call may use, in milliseconds. */
    readonly budgetMs: number;
    /** Instant the call started, in milliseconds. */
    readonly startedAt: number;
    /** Epoch instant after which the call is stopped, or undefined for no wall-clock limit. */
    readonly deadlineAt: number | undefined;
    /** Options of the call, which carry the grace periods and the write allowance. */
    readonly options: InvokeOptions;
    /** Host calls that the worker waits for. */
    pendingHost: number;
    /** Writes among the host calls that the worker waits for. */
    pendingWrites: number;
    /** Instant the first of the pending host calls started, while any is pending. */
    busySince: number | undefined;
    /** Host time of the calls that have finished, in milliseconds. */
    hostWaitMs: number;
    /** Settles the call with the text the guest function returned. */
    readonly resolve: (value: string) => void;
    /** Settles the call with the error it failed with. */
    readonly reject: (error: Error) => void;
    /** Periodic check of the watchdog. */
    timer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Runs guest scripts in a worker thread, so that a script cannot hold the event loop of the server.
 *
 * The worker holds one {@link SandboxRuntime}; host calls cross to the main thread as messages, and the main thread
 * serves them with its host. The main thread also watches each call: when the worker does not answer within the
 * wall-clock limit, or past its CPU budget with a margin, the main thread terminates the worker. A terminated
 * worker is never used again, so the registry replaces the runtime on the next call.
 *
 * `storage` lives in the worker. After each call the worker sends its JSON text back, so the main thread holds the
 * data when a worker is terminated and the next runtime of the same token can start with it. Data that cannot be
 * saved as JSON (cycles, functions) stays in the worker while it lives, and is lost when it is terminated.
 */
export class SandboxWorkerRuntime implements GuestRuntime {
    /** Interval between two checks of the watchdog while a call runs, in milliseconds. */
    private static readonly CHECK_INTERVAL_MS = 100;
    /** Guest CPU time past the budget that the main thread allows the worker before it terminates it, in milliseconds. */
    private static readonly CPU_BACKSTOP_MS = 2_000;
    /** Milliseconds a worker may take to start, load the module and evaluate the prelude. */
    private static readonly READY_TIMEOUT_MS = 30_000;
    /** Largest heap of a worker, in megabytes. The guest memory is WebAssembly memory and is not counted here. */
    private static readonly HEAP_LIMIT_MB = 512;
    /** Pattern of a plain identifier, the only form accepted as a function name. */
    private static readonly IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
    /** Runtimes whose worker is running. */
    /**
     * File name of the worker entry, without its extension. The build emits the bundle as `dist/<name>.js`
     * next to `dist/index.js`, and the sources have `<name>.ts` next to this file.
     */
    public static readonly ENTRY_NAME = "SandboxWorkerThread";

    private static readonly live = new Set<SandboxWorkerRuntime>();

    /** Worker that runs the guest, or undefined once it is terminated. */
    private worker: Worker | undefined;
    /** Call in progress. */
    private current: ActiveCall | undefined = undefined;
    /** Id of the last call. */
    private lastCallId = 0;
    /** Tail of the FIFO chain that serializes calls. */
    private queue: Promise<void> = Promise.resolve();
    /** Calls queued or running. */
    private pendingTasks = 0;
    /** Whether dispose was requested. */
    private isDisposed = false;
    /** Whether a fatal error or a limit made the runtime unusable. */
    private isPoisoned = false;
    /** WebAssembly memory of the guest, as the worker last reported it, in bytes. */
    private memoryBytes = 0;
    /** Memory size above which the idle runtime is spent. */
    private readonly recycleAboveBytes: number;
    /** Guest CPU time past the budgets that the main thread allows before it terminates the worker, in milliseconds. */
    private readonly cpuBackstopMs: number;
    /** CPU budget of the storage restore and of the storage read, in milliseconds. */
    private readonly storageBudgetMs: number;
    /** Note for the caller about the last call, such as storage that was not saved. */
    private notice: string | undefined = undefined;
    /** Storage as JSON text, as the worker last saved it, or undefined when there is none. */
    private savedStorage: string | undefined = undefined;
    /** Resolves once the worker has loaded the prelude. */
    private readonly started: Promise<void>;
    /** Settles {@link started} with success. */
    private startResolve: () => void = () => undefined;
    /** Settles {@link started} with failure. */
    private startReject: (error: Error) => void = () => undefined;
    /** Timer that fails the start when the worker does not come up in time. */
    private startTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    /** Whether the start has settled. */
    private startSettled = false;

    /**
     * Creates the runtime around a worker that is starting. The caller waits for {@link started}.
     *
     * @param worker - worker that loads the prelude
     * @param options - limits of the guest, used for the recycle size
     */
    private constructor(worker: Worker, options: SandboxRuntimeOptions, timing: WorkerTiming) {
        this.worker = worker;
        this.cpuBackstopMs = timing.cpuBackstopMs ?? SandboxWorkerRuntime.CPU_BACKSTOP_MS;
        this.storageBudgetMs = timing.storageBudgetMs ?? DEFAULT_STORAGE_BUDGET_MS;
        this.recycleAboveBytes = options.recycleAboveBytes ?? options.memoryLimitBytes ?? DEFAULT_GUEST_MEMORY_BYTES;
        this.started = new Promise<void>((resolve, reject) => {
            this.startResolve = resolve;
            this.startReject = reject;
        });
        this.startTimer = setTimeout(() => {
            this.failStart(new SandboxRuntimeError("The sandbox worker did not start in time.", undefined, true));
        }, SandboxWorkerRuntime.READY_TIMEOUT_MS);
        worker.on("message", (msg: WorkerMessage) => this.onMessage(worker, msg));
        worker.on("error", (error: Error) => this.onLost(worker, error));
        worker.on("exit", () => this.onLost(worker, undefined));
        // a worker that is idle must not keep the process alive; a call holds its own timer.
        worker.unref();
    }

    /**
     * Starts a worker and loads the prelude in it.
     *
     * @param prelude - guest source evaluated once in the worker, which defines the functions that `invoke` calls
     * @param options - memory and stack limits of the guest
     * @returns the ready runtime
     * @throws SandboxRuntimeError when the worker cannot start or the prelude fails
     */
    public static async create(
        prelude: string,
        options: SandboxRuntimeOptions = {},
        timing: WorkerTiming = {}
    ): Promise<SandboxWorkerRuntime> {
        const init: WorkerInit = {
            prelude,
            options,
            storageBudgetMs: timing.storageBudgetMs ?? DEFAULT_STORAGE_BUDGET_MS,
        };
        const worker = new Worker(SandboxWorkerRuntime.entryUrl(), {
            workerData: init,
            resourceLimits: { maxOldGenerationSizeMb: SandboxWorkerRuntime.HEAP_LIMIT_MB },
        });
        const runtime = new SandboxWorkerRuntime(worker, options, timing);
        await runtime.started;
        return runtime;
    }

    /**
     * Tells whether the worker entry is in this build. The entry is a TypeScript file when the server runs from its
     * sources, and a JavaScript file next to the bundle otherwise.
     *
     * @returns true when a worker can be started
     */
    public static isAvailable(): boolean {
        return existsSync(fileURLToPath(SandboxWorkerRuntime.entryUrl()));
    }

    /**
     * Counts the runtimes whose worker is running.
     *
     * @returns the number of live worker runtimes
     */
    public static liveCount(): number {
        return SandboxWorkerRuntime.live.size;
    }

    /** Whether the runtime was disposed. */
    public get disposed(): boolean {
        return this.isDisposed;
    }

    /** Whether a fatal error or a limit made the runtime unusable. */
    public get poisoned(): boolean {
        return this.isPoisoned;
    }

    /** WebAssembly memory of the guest, as the worker last reported it, in bytes. */
    public get wasmMemoryBytes(): number {
        return this.memoryBytes;
    }

    /** Whether the runtime is idle and its guest memory grew past the recycle size. */
    public get spent(): boolean {
        return !this.isDisposed && this.pendingTasks === 0 && this.memoryBytes > this.recycleAboveBytes;
    }

    /** Storage as JSON text, as the last call saved it; undefined when there is none to save. */
    public get storageSnapshot(): string | undefined {
        return this.savedStorage;
    }

    /**
     * Sets the storage that the next call starts with. The worker loads it before the call runs.
     *
     * @param text - storage as JSON text
     */
    public restoreStorage(text: string): void {
        this.savedStorage = text;
    }

    /**
     * Takes the note the worker made for the last call, and clears it.
     *
     * @returns the note, or undefined when there is none
     */
    public takeNotice(): string | undefined {
        const notice = this.notice;
        this.notice = undefined;
        return notice;
    }

    /**
     * Calls a global guest function with string arguments in the worker.
     *
     * @param functionName - name of a global guest function
     * @param stringArgs - arguments passed to the function
     * @param host - host that serves the host calls of the worker during this call
     * @param budgetMs - guest CPU time the call may use, in milliseconds
     * @param options - wall-clock limit, start hook and watchdog grace of the call
     * @returns the string the function returned
     * @throws SandboxRuntimeError when the guest fails, exceeds a limit or returns a non-string value
     */
    public invoke(
        functionName: string,
        stringArgs: string[],
        host: SandboxHostCalls,
        budgetMs: number,
        options: InvokeOptions = {}
    ): Promise<string> {
        if (!SandboxWorkerRuntime.IDENTIFIER.test(functionName)) {
            return Promise.reject(new Error(`"${functionName}" is not a valid function name.`));
        }
        return this.enqueue(() => this.runCall(functionName, stringArgs, host, budgetMs, options));
    }

    /**
     * Disposes the runtime and terminates its worker. A call in progress fails as discarded.
     */
    public dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        const call = this.current;
        if (call !== undefined) {
            this.current = undefined;
            clearInterval(call.timer);
            call.options.onAbandon?.();
            call.reject(new SandboxRuntimeError(RUNTIME_DISCARDED_MESSAGE, undefined, true));
        }
        this.terminate();
    }

    /**
     * Resolves the entry of the worker: the TypeScript source when the server runs from its sources, and the
     * JavaScript file next to the bundle otherwise.
     *
     * @returns the URL of the worker entry
     */
    private static entryUrl(): URL {
        const isSource = import.meta.url.endsWith(".ts");
        const extension = isSource ? "ts" : "js";
        return new URL(`./${SandboxWorkerRuntime.ENTRY_NAME}.${extension}`, import.meta.url);
    }

    /**
     * Queues a task behind the calls already queued.
     *
     * @param task - work that runs once the previous call has settled
     * @returns the result of the task
     */
    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        this.pendingTasks += 1;
        const result = this.queue.then(task);
        this.queue = result.then(
            () => this.finishTask(),
            () => this.finishTask()
        );
        return result;
    }

    /** Records that a queued task has settled. */
    private finishTask(): void {
        this.pendingTasks -= 1;
    }

    /**
     * Sends one call to the worker and watches it until its result comes back.
     *
     * @param functionName - name of a global guest function
     * @param stringArgs - arguments passed to the function
     * @param host - host that serves the host calls of the call
     * @param budgetMs - guest CPU time the call may use, in milliseconds
     * @param options - wall-clock limit, start hook and watchdog grace of the call
     * @returns the string the function returned
     */
    private runCall(
        functionName: string,
        stringArgs: string[],
        host: SandboxHostCalls,
        budgetMs: number,
        options: InvokeOptions
    ): Promise<string> {
        this.assertUsable();
        this.notice = undefined;
        const worker = this.worker;
        if (worker === undefined) {
            throw new SandboxRuntimeError(RUNTIME_DISCARDED_MESSAGE, undefined, true);
        }
        return new Promise<string>((resolve, reject) => {
            const now = Date.now();
            const deadlineAt = options.wallMs === undefined ? undefined : now + options.wallMs;
            this.lastCallId += 1;
            const call: ActiveCall = {
                id: this.lastCallId,
                host,
                budgetMs,
                startedAt: now,
                deadlineAt,
                options,
                pendingHost: 0,
                pendingWrites: 0,
                busySince: undefined,
                hostWaitMs: 0,
                resolve,
                reject,
                timer: undefined,
            };
            this.current = call;
            options.onStart?.(deadlineAt ?? Number.POSITIVE_INFINITY);
            call.timer = setInterval(() => this.check(call), SandboxWorkerRuntime.CHECK_INTERVAL_MS);
            const request: WorkerRequest = {
                type: "invoke",
                id: call.id,
                functionName,
                args: stringArgs,
                budgetMs,
                wallMs: options.wallMs,
                storage: this.savedStorage,
            };
            worker.postMessage(request);
        });
    }

    /**
     * Checks a call against its limits, and terminates the worker when it has gone past them.
     *
     * The wall clock gives a write its allowance, as the in-process runtime does. The CPU budget counts the time the
     * worker waits for the host, which the main thread excludes, as the worker does.
     *
     * @param call - call in progress
     */
    private check(call: ActiveCall): void {
        if (this.current !== call) {
            return;
        }
        const now = Date.now();
        if (call.deadlineAt !== undefined) {
            const writing = call.pendingWrites > 0;
            const graceMs = writing
                ? (call.options.writeGraceMs ?? WATCHDOG_WRITE_GRACE_MS) + (call.options.writeAllowanceMs?.() ?? 0)
                : (call.options.graceMs ?? WATCHDOG_GRACE_MS);
            if (now > call.deadlineAt + graceMs) {
                this.abandon(call, "wall");
                return;
            }
        }
        const hostMs = call.hostWaitMs + (call.busySince !== undefined ? now - call.busySince : 0);
        // the worker gives the restore, the script and the storage read each the budget, so all three are allowed.
        const allowedMs = call.budgetMs + 2 * this.storageBudgetMs + this.cpuBackstopMs;
        if (now - call.startedAt - hostMs > allowedMs) {
            this.abandon(call, "cpu");
        }
    }

    /**
     * Ends a call that the worker did not answer in time, and terminates the worker.
     *
     * @param call - call in progress
     * @param limit - the limit that the call went past
     */
    private abandon(call: ActiveCall, limit: "cpu" | "wall"): void {
        this.current = undefined;
        clearInterval(call.timer);
        this.isPoisoned = true;
        this.terminate();
        call.options.onAbandon?.();
        const message = limit === "cpu" ? cpuLimitMessage(call.budgetMs) : WALL_CLOCK_MESSAGE;
        call.reject(new SandboxRuntimeError(message, undefined, true, limit));
    }

    /**
     * Takes the answer of a call: its value or its error, and the storage and memory that the worker reports.
     *
     * @param call - call in progress
     * @param msg - the result that the worker sent
     */
    private finish(call: ActiveCall, msg: ResultMessage): void {
        this.current = undefined;
        clearInterval(call.timer);
        this.memoryBytes = msg.memoryBytes;
        if (msg.warning !== undefined) {
            this.notice = msg.warning;
        }
        if (msg.storage === null) {
            this.savedStorage = undefined;
        } else if (typeof msg.storage === "string") {
            this.savedStorage = msg.storage;
        }
        if (msg.poisoned) {
            // a fatal error leaves the guest unreliable; the worker is not used again, so it goes now.
            this.isPoisoned = true;
            this.terminate();
        }
        if (msg.ok) {
            call.resolve(msg.value);
        } else {
            call.reject(SandboxWorkerRuntime.toError(msg.error));
        }
    }

    /**
     * Converts the error of a worker call back into the error that the in-process runtime throws.
     *
     * @param error - error as the worker reported it
     * @returns a runtime error, or a plain error for a failure outside the runtime
     */
    private static toError(error: WorkerError): Error {
        if (!error.runtime) {
            return new Error(error.message);
        }
        return new SandboxRuntimeError(error.message, error.guestName, error.fatal, error.limit);
    }

    /**
     * Routes a message of the worker. Messages of a terminated worker are ignored.
     *
     * @param worker - worker that sent the message
     * @param msg - the message
     */
    private onMessage(worker: Worker, msg: WorkerMessage): void {
        if (worker !== this.worker) {
            return;
        }
        switch (msg.type) {
            case "ready":
                this.memoryBytes = msg.memoryBytes;
                this.settleStart();
                return;
            case "init-failed":
                this.failStart(new SandboxRuntimeError(msg.message, undefined, true));
                return;
            case "host-call": {
                const call = this.current;
                if (call !== undefined) {
                    void this.serveHostCall(worker, call, msg);
                }
                return;
            }
            case "result": {
                const call = this.current;
                if (call !== undefined && call.id === msg.id) {
                    this.finish(call, msg);
                }
                return;
            }
        }
    }

    /**
     * Serves one host call of the worker, and sends its answer back.
     *
     * @param worker - worker that asked
     * @param call - call in progress, which the host call belongs to
     * @param msg - the host call
     */
    private async serveHostCall(worker: Worker, call: ActiveCall, msg: HostCallMessage): Promise<void> {
        const writes = WRITE_PRIMITIVES.has(msg.name);
        this.beginHostCall(call, writes);
        let reply: WorkerHostResult;
        try {
            const value = await dispatchHostCall(call.host, msg.name, msg.args);
            reply = { type: "host-result", id: msg.id, ok: true, value };
        } catch (error) {
            reply = { type: "host-result", id: msg.id, ok: false, message: messageOf(error) };
        }
        this.endHostCall(call, writes);
        if (this.worker === worker && this.current === call) {
            worker.postMessage(reply);
        }
    }

    /**
     * Records that the worker waits for a host call.
     *
     * @param call - call in progress
     * @param writes - whether the host call changes data
     */
    private beginHostCall(call: ActiveCall, writes: boolean): void {
        call.pendingHost += 1;
        if (writes) {
            call.pendingWrites += 1;
        }
        if (call.pendingHost === 1) {
            call.busySince = Date.now();
        }
    }

    /**
     * Records that a host call has answered.
     *
     * @param call - call in progress
     * @param writes - whether the host call changed data
     */
    private endHostCall(call: ActiveCall, writes: boolean): void {
        call.pendingHost -= 1;
        if (writes) {
            call.pendingWrites -= 1;
        }
        if (call.pendingHost === 0 && call.busySince !== undefined) {
            call.hostWaitMs += Date.now() - call.busySince;
            call.busySince = undefined;
        }
    }

    /**
     * Handles the loss of a worker: an error, or an exit that the runtime did not ask for.
     *
     * @param worker - worker that was lost
     * @param error - the error that stopped it, when there was one
     */
    private onLost(worker: Worker, error: Error | undefined): void {
        if (worker !== this.worker) {
            return;
        }
        this.worker = undefined;
        SandboxWorkerRuntime.live.delete(this);
        this.isPoisoned = true;
        const code = (error as { code?: unknown } | undefined)?.code;
        const failure =
            code === "ERR_WORKER_OUT_OF_MEMORY"
                ? new SandboxRuntimeError(
                      "The script exceeded the sandbox worker memory limit",
                      undefined,
                      true,
                      "memory"
                  )
                : new SandboxRuntimeError("The sandbox worker stopped unexpectedly", undefined, true);
        if (!this.startSettled) {
            this.failStart(failure);
        }
        const call = this.current;
        if (call !== undefined) {
            this.current = undefined;
            clearInterval(call.timer);
            call.options.onAbandon?.();
            call.reject(failure);
        }
    }

    /** Terminates the worker, once. A call that the worker was running is not answered. */
    private terminate(): void {
        const worker = this.worker;
        this.worker = undefined;
        SandboxWorkerRuntime.live.delete(this);
        if (worker !== undefined) {
            void worker.terminate();
        }
    }

    /** Marks the start as done with success. */
    private settleStart(): void {
        if (this.startSettled) {
            return;
        }
        this.startSettled = true;
        clearTimeout(this.startTimer);
        SandboxWorkerRuntime.live.add(this);
        this.startResolve();
    }

    /**
     * Marks the start as failed and terminates the worker.
     *
     * @param error - the reason
     */
    private failStart(error: SandboxRuntimeError): void {
        if (this.startSettled) {
            return;
        }
        this.startSettled = true;
        clearTimeout(this.startTimer);
        this.isPoisoned = true;
        this.startReject(error);
        this.terminate();
    }

    /**
     * Rejects a call on a runtime that is disposed or poisoned.
     *
     * @throws SandboxRuntimeError when the runtime must not be used
     */
    private assertUsable(): void {
        if (this.isDisposed || this.isPoisoned) {
            throw new SandboxRuntimeError(RUNTIME_DISCARDED_MESSAGE, undefined, true);
        }
    }
}

/**
 * Reads a string argument of a host call.
 *
 * @param args - arguments of the host call
 * @param index - position of the argument
 * @returns the argument text
 * @throws Error when the argument is missing or not a string
 */
function text(args: readonly (string | boolean)[], index: number): string {
    const arg = args[index];
    if (typeof arg !== "string") {
        throw new Error(`argument ${index + 1} must be a string.`);
    }
    return arg;
}

/**
 * Reads a boolean argument of a host call.
 *
 * @param args - arguments of the host call
 * @param index - position of the argument
 * @returns the argument value
 * @throws Error when the argument is missing or not a boolean
 */
function flag(args: readonly (string | boolean)[], index: number): boolean {
    const arg = args[index];
    if (typeof arg !== "boolean") {
        throw new Error(`argument ${index + 1} must be a boolean.`);
    }
    return arg;
}

/**
 * Routes one host call to its method on the host.
 *
 * @param host - host that serves the call
 * @param name - primitive that the guest called
 * @param args - arguments that the worker sent
 * @returns the host's answer
 */
function dispatchHostCall(
    host: SandboxHostCalls,
    name: HostPrimitiveName,
    args: readonly (string | boolean)[]
): Promise<string> {
    switch (name) {
        case "loadFileOutline":
            return host.loadFileOutline(text(args, 0));
        case "loadPage":
            return host.loadPage(text(args, 0), text(args, 1));
        case "flush":
            return host.flush(text(args, 0), text(args, 1), flag(args, 2));
        case "importSvg":
            return host.importSvg(text(args, 0));
        case "rpc":
            return host.rpc(text(args, 0), text(args, 1));
        case "exportShape":
            return host.exportShape(text(args, 0));
        case "uploadMediaUrl":
            return host.uploadMediaUrl(text(args, 0));
        case "uploadMediaData":
            return host.uploadMediaData(text(args, 0));
    }
}

/**
 * Returns the text of an unknown thrown value.
 *
 * @param error - thrown value
 * @returns the message of an Error, or the string form of any other value
 */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
