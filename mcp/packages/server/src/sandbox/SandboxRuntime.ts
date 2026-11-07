import {
    newQuickJSAsyncWASMModule,
    newVariant,
    RELEASE_ASYNC,
    type QuickJSAsyncContext,
    type QuickJSHandle,
} from "quickjs-emscripten";
import { createLogger } from "../logger";
import {
    DEFAULT_GUEST_MEMORY_BYTES,
    HOST_PRIMITIVE_NAMES,
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
    SandboxRuntimeError,
} from "./GuestRuntime";
import { SandboxSettings } from "./SandboxSettings";
import { STORAGE_BRIDGE, STORAGE_GETTER, STORAGE_SETTER } from "./SandboxWorkerProtocol";
import { SandboxWorkerRuntime } from "./SandboxWorkerRuntime";

export {
    RUNTIME_DISCARDED_MESSAGE,
    SandboxRuntimeError,
    type InvokeOptions,
    type SandboxHostCalls,
    type SandboxLimit,
    type SandboxRuntimeOptions,
} from "./GuestRuntime";

/** The part of a `WebAssembly.Memory` that the runtime uses; the compiler options of this package lack its types. */
interface WasmMemory {
    /** Bytes of the memory; its length is the current size. */
    readonly buffer: ArrayBuffer;
}

/** Constructor of `WebAssembly.Memory`, with sizes in 64 KiB pages. */
const WasmMemoryClass = (
    globalThis as unknown as {
        WebAssembly: { Memory: new (descriptor: { initial: number; maximum: number }) => WasmMemory };
    }
).WebAssembly.Memory;

/** Bookkeeping of the run in progress. */
interface ActiveRun {
    /** Instant the run started, in milliseconds. */
    readonly startedAt: number;
    /** Guest CPU time the run may use, in milliseconds. */
    readonly budgetMs: number;
    /** Whether the interrupt handler stopped the run for exceeding its budget. */
    budgetExceeded: boolean;
    /** Epoch instant after which the run is stopped, or undefined when the run has no wall-clock limit. */
    readonly deadlineAt: number | undefined;
    /** Whether the wall-clock deadline stopped the run. */
    wallExceeded: boolean;
}

/**
 * Runs guest scripts in one QuickJS async context that belongs to one MCP session.
 *
 * Calls run one after another. The CPU budget of a call counts guest execution only: the time that
 * the guest waits for a host primitive is excluded. A fatal error poisons the runtime, and every later
 * call fails until the owner discards it.
 *
 * The execution model is asyncify with synchronous guest code. A host primitive suspends the whole guest
 * stack until its host answer arrives, so guest code calls `__host.*` as ordinary functions and never awaits.
 * Host primitives called after an `await` inside guest code corrupt the module, so the facade never
 * returns promises and user scripts that use `await` are rejected with a hint.
 *
 * Each runtime owns its own WebAssembly module instance, whose memory has a fixed maximum. The memory of a
 * WebAssembly instance never shrinks, so a runtime whose memory grew past the recycle size is spent once idle:
 * the owner should dispose it and drop every reference, so that the instance and its memory can be collected.
 * The QuickJS memory limit alone does not bound the heap in this build, because it counts a few bytes per block
 * whatever the block size; the maximum of the WebAssembly memory is the limit that holds.
 */
export class SandboxRuntime implements GuestRuntime {
    /** Names of the host primitives installed on the global `__host` object. */
    public static readonly HOST_PRIMITIVE_NAMES = HOST_PRIMITIVE_NAMES;
    /** Logger of the runtime choice and of the fallback to the main thread. */
    private static readonly log = createLogger("SandboxRuntime");
    /** Whether guests run in worker threads, read once from the environment. Undefined until the first create. */
    private static workersChosen: boolean | undefined = undefined;
    /** Default memory budget of the guest, in bytes. */
    private static readonly DEFAULT_MEMORY_LIMIT_BYTES = DEFAULT_GUEST_MEMORY_BYTES;
    /**
     * Default call stack limit of the guest, in bytes.
     *
     * A larger limit lets the host stack overflow first, which surfaces as an uncatchable RangeError.
     */
    private static readonly DEFAULT_STACK_SIZE_BYTES = 256 * 1024;
    /** CPU budget of the prelude, in milliseconds. */
    private static readonly PRELUDE_BUDGET_MS = 10_000;
    /** Pattern of a plain identifier, the only form accepted as a function name. */
    private static readonly IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
    /** Message of the error that a run raises once its wall-clock deadline has passed. */
    private static readonly WALL_CLOCK_MESSAGE = WALL_CLOCK_MESSAGE;
    /** Milliseconds the watchdog waits past the deadline when no host write is in flight. */
    private static readonly DEFAULT_GRACE_MS = WATCHDOG_GRACE_MS;
    /** Milliseconds the watchdog waits past the deadline while a host write is in flight. */
    private static readonly DEFAULT_WRITE_GRACE_MS = WATCHDOG_WRITE_GRACE_MS;
    /** Guest globals that the runner and the facade use; they cannot be replaced once the prelude is installed. */
    private static readonly FROZEN_GLOBALS: readonly string[] = [
        "__runScript",
        "__drainLog",
        "__core",
        "__codec",
        "__host",
        "console",
        "penpot",
        "penpotMgmt",
        "penpotUtils",
        STORAGE_SETTER,
        STORAGE_GETTER,
    ];
    /** Runtimes that have been created and not yet disposed, on the main thread. */
    private static readonly live = new Set<SandboxRuntime>();
    /** Size of one WebAssembly memory page, in bytes. */
    private static readonly WASM_PAGE_BYTES = 65_536;
    /** Initial size of the WebAssembly memory, in bytes, which the QuickJS build expects. */
    private static readonly WASM_INITIAL_BYTES = 16 * 1024 * 1024;

    /** Whether the host primitives are refused for the call in progress. */
    private hostRefused = false;
    /** Host that serves the primitives of the current call. */
    private host: SandboxHostCalls | undefined = undefined;
    /** Run in progress, watched by the interrupt handler. */
    private activeRun: ActiveRun | undefined = undefined;
    /** Host time of the run in progress, in milliseconds. */
    private hostWaitMs = 0;
    /** Tail of the FIFO chain that serializes calls. */
    private queue: Promise<void> = Promise.resolve();
    /** Calls queued or running. */
    private pendingTasks = 0;
    /** Whether the QuickJS context has been freed. */
    private contextReleased = false;
    /** Whether dispose was requested. */
    private isDisposed = false;
    /** Whether a fatal error made the guest context unreliable. */
    private isPoisoned = false;
    /**
     * Depth of the host code that runs guest code without a suspension point: the pending jobs and the value
     * reads. While it is above zero, a host primitive called from the guest gets a synchronous error.
     */
    private noSuspendDepth = 0;
    /**
     * Facade and intrinsic roots that are frozen deeply. The built-in constructors reach the prototypes, so
     * freezing them also freezes the methods the runner and the facade call.
     */
    private static readonly FROZEN_ROOTS: readonly string[] = [
        "penpot",
        "penpotMgmt",
        "penpotUtils",
        "console",
        "__core",
        "__host",
        "__codec",
        "JSON",
        "Math",
        "Object",
        "Array",
        "String",
        "Number",
        "Boolean",
        "Function",
        "Error",
        "Map",
        "Set",
        "RegExp",
    ];
    /** Host writes that the guest waits for; the watchdog waits while one is in flight. */
    private writesInFlight = 0;
    /** Whether the watchdog stopped a call that never returned. The context is then kept, not freed. */
    private isStuck = false;
    /** Whether guest code is suspended in an evaluation that has not returned yet. */
    private evalOutstanding = false;

    /**
     * Creates a runtime around a context that is already configured.
     *
     * @param context - async QuickJS context owned by this runtime
     * @param memory - WebAssembly memory of the module instance that runs the context
     * @param memoryLimitBytes - memory budget of the context, used to word the out-of-memory error
     * @param recycleAboveBytes - memory size above which the idle runtime is spent
     */
    private constructor(
        private readonly context: QuickJSAsyncContext,
        private readonly memory: WasmMemory,
        private readonly memoryLimitBytes: number,
        private readonly recycleAboveBytes: number
    ) {
        context.runtime.setInterruptHandler(() => this.shouldInterrupt());
    }

    /**
     * Creates a guest runtime, in a worker thread unless the workers are switched off.
     *
     * `PENPOT_MCP_SANDBOX_WORKERS` picks the thread: a worker keeps a script off the main thread, and the main
     * thread can stop it. When the worker entry is not in the build, the runtime runs on the main thread.
     *
     * @param prelude - guest source evaluated once, which defines the functions that `invoke` calls
     * @param options - memory and stack limits of the guest
     * @returns the ready runtime
     * @throws SandboxRuntimeError when the prelude fails
     */
    public static async create(
        prelude: string,
        options: SandboxRuntimeOptions = {},
        workers?: boolean
    ): Promise<GuestRuntime> {
        if (SandboxRuntime.workersOn(workers)) {
            return SandboxWorkerRuntime.create(prelude + "\n" + STORAGE_BRIDGE, options);
        }
        return SandboxRuntime.createInProcess(prelude, options);
    }

    /**
     * Tells whether guests run in worker threads. The environment is read once, at the first creation, and the
     * choice is logged then. Workers need the worker entry in the build; without it, guests run on the main thread.
     *
     * @returns true when new runtimes run in worker threads
     */
    private static workersOn(requested?: boolean): boolean {
        if (SandboxRuntime.workersChosen === undefined) {
            const enabled = requested ?? SandboxSettings.workersEnabled(process.env);
            const available = enabled && SandboxWorkerRuntime.isAvailable();
            if (enabled && !available) {
                SandboxRuntime.log.warn(
                    "The sandbox worker entry is not in this build; execute_code runs on the main thread."
                );
            }
            SandboxRuntime.log.info("Sandbox guests run %s", available ? "in worker threads" : "on the main thread");
            SandboxRuntime.workersChosen = available;
        }
        return SandboxRuntime.workersChosen;
    }

    /**
     * Creates a sandbox in a new WebAssembly module instance on the current thread, and evaluates the prelude in it.
     *
     * @param prelude - guest source evaluated once, which defines the functions that `invoke` calls
     * @param options - memory and stack limits of the guest
     * @returns the ready runtime
     * @throws SandboxRuntimeError when the prelude fails
     */
    public static async createInProcess(prelude: string, options: SandboxRuntimeOptions = {}): Promise<SandboxRuntime> {
        const memoryLimitBytes = options.memoryLimitBytes ?? SandboxRuntime.DEFAULT_MEMORY_LIMIT_BYTES;
        const stackSizeBytes = options.stackSizeBytes ?? SandboxRuntime.DEFAULT_STACK_SIZE_BYTES;
        const wasmLimitBytes = Math.max(
            SandboxRuntime.WASM_INITIAL_BYTES,
            options.wasmMemoryLimitBytes ?? 2 * memoryLimitBytes
        );
        const recycleAboveBytes = options.recycleAboveBytes ?? memoryLimitBytes;
        const module = await newQuickJSAsyncWASMModule(
            newVariant(RELEASE_ASYNC, {
                // a loader function, so that every module instance gets a memory of its own.
                wasmMemory: () =>
                    new WasmMemoryClass({
                        initial: SandboxRuntime.WASM_INITIAL_BYTES / SandboxRuntime.WASM_PAGE_BYTES,
                        maximum: Math.floor(wasmLimitBytes / SandboxRuntime.WASM_PAGE_BYTES),
                    }),
            })
        );
        const context = module.newContext();
        const runtime = new SandboxRuntime(context, module.getWasmMemory(), memoryLimitBytes, recycleAboveBytes);
        try {
            context.runtime.setMemoryLimit(memoryLimitBytes);
            context.runtime.setMaxStackSize(stackSizeBytes);
            runtime.installHostPrimitives();
            await runtime.execute(prelude, SandboxRuntime.PRELUDE_BUDGET_MS, undefined);
            await runtime.freezeGlobals();
        } catch (error) {
            runtime.dispose();
            throw error;
        }
        SandboxRuntime.live.add(runtime);
        return runtime;
    }

    /**
     * Counts the runtimes that have been created and not yet disposed, on the main thread and in workers.
     *
     * @returns the number of live runtimes
     */
    public static liveCount(): number {
        return SandboxRuntime.live.size + SandboxWorkerRuntime.liveCount();
    }

    /** Whether the runtime was disposed. */
    public get disposed(): boolean {
        return this.isDisposed;
    }

    /** Notes are made by worker runtimes only, so an in-process runtime has none. */
    public takeNotice(): undefined {
        return undefined;
    }

    /** Whether a fatal error made the runtime unusable. */
    public get poisoned(): boolean {
        return this.isPoisoned;
    }

    /** Storage is kept in the guest, so an in-process runtime has no saved copy of it. */
    public get storageSnapshot(): undefined {
        return undefined;
    }

    /** Storage is kept in the guest, so there is nothing to restore; the call is a no-op. */
    public restoreStorage(): void {
        // no-op: see storageSnapshot
    }

    /** Current size of the WebAssembly memory of the runtime, in bytes. It never shrinks. */
    public get wasmMemoryBytes(): number {
        return this.memory.buffer.byteLength;
    }

    /**
     * Whether the runtime is idle and its WebAssembly memory grew past the recycle size.
     *
     * A spent runtime still works, but it holds its peak memory for as long as it lives.
     */
    public get spent(): boolean {
        return !this.isDisposed && this.pendingTasks === 0 && this.wasmMemoryBytes > this.recycleAboveBytes;
    }

    /**
     * Calls a global guest function with string arguments.
     *
     * The function must return a string; its value is read without settling any guest promise. Calls run in FIFO order.
     *
     * @param functionName - name of a global guest function
     * @param stringArgs - arguments passed to the function
     * @param host - host that serves the host primitives during this call
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
        if (!SandboxRuntime.IDENTIFIER.test(functionName)) {
            return Promise.reject(new Error(`"${functionName}" is not a valid function name.`));
        }
        // the arguments are JSON string literals in the source, so no global is written outside a run.
        const argumentList = stringArgs.map((arg) => JSON.stringify(arg)).join(", ");
        const source = `${functionName}(${argumentList})`;
        return this.enqueue(() =>
            this.watched(options, async (deadlineAt) => {
                this.hostRefused = options.refuseHost === true;
                let result: string | undefined;
                try {
                    result = await this.execute(source, budgetMs, host, deadlineAt);
                } finally {
                    this.hostRefused = false;
                }
                if (result === undefined) {
                    throw new SandboxRuntimeError("The script must return a string.");
                }
                return result;
            })
        );
    }

    /**
     * Runs one queued call under the watchdog. The call starts its wall clock here, once it is its turn to run.
     *
     * The watchdog answers a call that never returns: a host answer that does not come, or a guest that waits on
     * one. It fires at the deadline plus a grace period, or later while a host write is in flight, since a write is
     * not abandoned. When it fires the runtime is poisoned and its context is kept, because the guest may still
     * wait on the host.
     *
     * @param options - wall-clock limit, start hook and grace periods of the call
     * @param task - the call, given the deadline of the call or undefined for none
     * @returns the result of the task, or a fatal error from the watchdog
     */
    private async watched<T>(options: InvokeOptions, task: (deadlineAt: number | undefined) => Promise<T>): Promise<T> {
        this.assertUsable();
        const wallMs = options.wallMs;
        const deadlineAt = wallMs === undefined ? undefined : Date.now() + wallMs;
        options.onStart?.(deadlineAt ?? Number.POSITIVE_INFINITY);
        const running = task(deadlineAt);
        if (deadlineAt === undefined) {
            return running;
        }
        const graceMs = options.graceMs ?? SandboxRuntime.DEFAULT_GRACE_MS;
        const writeGraceMs = options.writeGraceMs ?? SandboxRuntime.DEFAULT_WRITE_GRACE_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const watchdog = new Promise<never>((_, reject) => {
            const fire = (): void => {
                const now = Date.now();
                const allowance = this.writesInFlight > 0 ? (options.writeAllowanceMs?.() ?? 0) : 0;
                const limit = this.writesInFlight > 0 ? deadlineAt + writeGraceMs + allowance : deadlineAt + graceMs;
                if (now < limit) {
                    timer = setTimeout(fire, limit - now);
                    return;
                }
                this.isPoisoned = true;
                this.isStuck = true;
                reject(new SandboxRuntimeError(SandboxRuntime.WALL_CLOCK_MESSAGE, undefined, true, "wall"));
            };
            timer = setTimeout(fire, Math.max(0, deadlineAt + graceMs - Date.now()));
        });
        try {
            return await Promise.race([running, watchdog]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Disposes the QuickJS context and removes the runtime from the live set.
     *
     * The context is freed once the call in progress, if any, has finished. Calling this more than once has no effect.
     */
    public dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        SandboxRuntime.live.delete(this);
        if (this.pendingTasks === 0) {
            this.releaseContext();
        }
    }

    /** Installs the host primitives as asyncified functions on the global `__host` object. */
    private installHostPrimitives(): void {
        const hostObject = this.context.newObject();
        for (const name of SandboxRuntime.HOST_PRIMITIVE_NAMES) {
            const primitive = this.context.newAsyncifiedFunction(name, (...args: QuickJSHandle[]) =>
                this.primitiveCallback(name, args)
            );
            this.context.setProp(hostObject, name, primitive);
            primitive.dispose();
        }
        this.context.setProp(this.context.global, "__host", hostObject);
        hostObject.dispose();
    }

    /**
     * Enters a host primitive from the guest, refusing the call while the pending jobs run.
     *
     * A call from a resumed job cannot suspend the guest, because the jobs run outside the asyncified
     * region. Such a call returns synchronously with an error, which the guest sees as a thrown Error.
     *
     * @param name - primitive that guest code called
     * @param args - guest argument handles
     * @returns the answer of the primitive, or a synchronous error for a call from a job
     */
    private primitiveCallback(
        name: HostPrimitiveName,
        args: QuickJSHandle[]
    ): Promise<QuickJSHandle | { error: QuickJSHandle }> {
        if (this.hostRefused) {
            const error = this.context.newError("host calls are not allowed in this call");
            return { error } as unknown as Promise<QuickJSHandle | { error: QuickJSHandle }>;
        }
        if (this.noSuspendDepth > 0) {
            const error = this.context.newError("host primitives cannot be called from this code");
            return { error } as unknown as Promise<QuickJSHandle | { error: QuickJSHandle }>;
        }
        return this.callPrimitive(name, args);
    }

    /**
     * Serves one host primitive call and converts a failure into a guest exception.
     *
     * @param name - primitive that guest code called
     * @param args - guest argument handles, read before the first await
     * @returns a string handle, or an error handle that the guest sees as a thrown Error
     */
    private async callPrimitive(
        name: HostPrimitiveName,
        args: QuickJSHandle[]
    ): Promise<QuickJSHandle | { error: QuickJSHandle }> {
        try {
            const text = await this.dispatch(name, args);
            return this.context.newString(text);
        } catch (error) {
            const message = SandboxRuntime.messageOf(error);
            return { error: this.withoutSuspend(() => this.context.newError(message)) };
        }
    }

    /**
     * Calls the host for one primitive and excludes its duration from the CPU budget.
     *
     * @param name - primitive that guest code called
     * @param args - guest argument handles, read before the first await
     * @returns the text the host returned
     */
    private async dispatch(name: HostPrimitiveName, args: QuickJSHandle[]): Promise<string> {
        const host = this.host;
        if (host === undefined) {
            throw new Error("no host attached");
        }
        const run = this.activeRun;
        const started = Date.now();
        const isWrite = WRITE_PRIMITIVES.has(name);
        if (isWrite) {
            this.writesInFlight += 1;
        }
        try {
            if (run !== undefined && run.deadlineAt !== undefined && started >= run.deadlineAt) {
                run.wallExceeded = true;
                throw new Error(SandboxRuntime.WALL_CLOCK_MESSAGE);
            }
            const hostCall = this.invokeHost(host, name, args);
            // a write is waited for in full, so its answer is recorded; the script stops after it.
            const result: unknown = isWrite ? await hostCall : await this.untilDeadline(hostCall, run);
            if (isWrite && run !== undefined && run.deadlineAt !== undefined && Date.now() >= run.deadlineAt) {
                // the write is recorded; the script stops here, even when the guest has no more code to interrupt.
                run.wallExceeded = true;
            }
            if (typeof result !== "string") {
                throw new Error(`${name} must resolve to a string.`);
            }
            return result;
        } finally {
            if (isWrite) {
                this.writesInFlight -= 1;
            }
            this.hostWaitMs += Date.now() - started;
        }
    }

    /**
     * Waits for a host call, or for the wall-clock deadline of the run, whichever comes first.
     *
     * When the deadline wins, the run is marked as stopped by the wall clock. A late rejection of the host call
     * is absorbed, because the guest no longer waits for it.
     *
     * @param hostCall - promise of the host answer
     * @param run - run in progress, which may have no deadline
     * @returns the host answer
     * @throws Error with the wall-clock message when the deadline passes before the host answers
     */
    private async untilDeadline(hostCall: Promise<unknown>, run: ActiveRun | undefined): Promise<unknown> {
        const deadlineAt = run?.deadlineAt;
        if (run === undefined || deadlineAt === undefined) {
            return hostCall;
        }
        hostCall.catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => {
                    run.wallExceeded = true;
                    reject(new Error(SandboxRuntime.WALL_CLOCK_MESSAGE));
                },
                Math.max(0, deadlineAt - Date.now())
            );
        });
        try {
            return await Promise.race([hostCall, expired]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Routes one primitive to its host method.
     *
     * The arguments are read synchronously, because QuickJS frees them when the guest call suspends.
     *
     * @param host - host that serves the call
     * @param name - primitive that guest code called
     * @param args - guest argument handles
     * @returns the host's answer
     */
    private invokeHost(host: SandboxHostCalls, name: HostPrimitiveName, args: QuickJSHandle[]): Promise<string> {
        switch (name) {
            case "loadFileOutline":
                return host.loadFileOutline(this.readString(args, 0));
            case "loadPage":
                return host.loadPage(this.readString(args, 0), this.readString(args, 1));
            case "flush":
                return host.flush(this.readString(args, 0), this.readString(args, 1), this.readBoolean(args, 2));
            case "importSvg":
                return host.importSvg(this.readString(args, 0));
            case "rpc":
                return host.rpc(this.readString(args, 0), this.readString(args, 1));
            case "exportShape":
                return host.exportShape(this.readString(args, 0));
            case "uploadMediaUrl":
                return host.uploadMediaUrl(this.readString(args, 0));
            case "uploadMediaData":
                return host.uploadMediaData(this.readString(args, 0));
        }
    }

    /**
     * Reads a string argument of a host primitive.
     *
     * @param args - guest argument handles
     * @param index - position of the argument
     * @returns the argument text
     * @throws Error when the argument is missing or not a string
     */
    private readString(args: QuickJSHandle[], index: number): string {
        const arg = args[index];
        if (arg === undefined || this.context.typeof(arg) !== "string") {
            throw new Error(`argument ${index + 1} must be a string.`);
        }
        return this.context.getString(arg);
    }

    /**
     * Reads a boolean argument of a host primitive.
     *
     * @param args - guest argument handles
     * @param index - position of the argument
     * @returns the argument value
     * @throws Error when the argument is missing or not a boolean
     */
    private readBoolean(args: QuickJSHandle[], index: number): boolean {
        const arg = args[index];
        // only a primitive is dumped: an object could run guest code in its toJSON.
        if (arg === undefined || this.context.typeof(arg) !== "boolean") {
            throw new Error(`argument ${index + 1} must be a boolean.`);
        }
        const value: unknown = this.withoutSuspend(() => this.context.dump(arg));
        if (typeof value !== "boolean") {
            throw new Error(`argument ${index + 1} must be a boolean.`);
        }
        return value;
    }

    /**
     * Runs a library call that may run guest code, such as a getter, with host primitives refused.
     *
     * A guest getter that calls a host primitive would suspend the guest inside a synchronous library call, which
     * corrupts the module. While the call runs, such a primitive gets a synchronous error instead.
     *
     * @param action - the library call
     * @returns the value of the call
     */
    private withoutSuspend<T>(action: () => T): T {
        this.noSuspendDepth += 1;
        try {
            return action();
        } finally {
            this.noSuspendDepth -= 1;
        }
    }

    /**
     * Makes the runner, the facade and the intrinsics read-only, once the prelude is installed.
     *
     * Each script of a runtime shares these objects, so a script that replaced one (a global, a facade method, or
     * `JSON.stringify`, which the flush uses) would change what the later scripts do and report. Every object
     * reachable from the facade roots and from the built-in constructors is frozen, so reads and calls still work
     * but nothing can be replaced. `storage` stays writable: it is the data of the user. The freeze runs as a run
     * with its own budget, so the interrupt handler covers it.
     */
    private async freezeGlobals(): Promise<void> {
        const source =
            "(function (names, roots, keep) {" +
            "  var seen = new Set();" +
            "  seen.add(globalThis);" +
            // the host sets name and message on new error objects, so Error.prototype must stay writable.
            "  seen.add(Error.prototype);" +
            "  if (keep !== undefined) { seen.add(globalThis[keep]); }" +
            "  names.forEach(function (name) {" +
            "    if (Object.prototype.hasOwnProperty.call(globalThis, name)) {" +
            "      Object.defineProperty(globalThis, name, { writable: false, configurable: false });" +
            "    }" +
            "  });" +
            "  function freezeDeep(value) {" +
            "    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) {" +
            "      return;" +
            "    }" +
            "    seen.add(value);" +
            "    Object.freeze(value);" +
            "    Object.getOwnPropertyNames(value).forEach(function (key) {" +
            "      var d = Object.getOwnPropertyDescriptor(value, key);" +
            "      if (d === undefined) { return; }" +
            "      if ('value' in d) { freezeDeep(d.value); }" +
            "      if (d.get) { freezeDeep(d.get); }" +
            "      if (d.set) { freezeDeep(d.set); }" +
            "    });" +
            "  }" +
            "  roots.forEach(function (name) { freezeDeep(globalThis[name]); });" +
            "})(" +
            JSON.stringify(SandboxRuntime.FROZEN_GLOBALS) +
            "," +
            JSON.stringify(SandboxRuntime.FROZEN_ROOTS) +
            "," +
            JSON.stringify("storage") +
            ");";
        await this.execute(source, SandboxRuntime.PRELUDE_BUDGET_MS, undefined);
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

    /** Records that a queued task has settled, and frees the context if it was disposed meanwhile. */
    private finishTask(): void {
        this.pendingTasks -= 1;
        if (this.isDisposed && this.pendingTasks === 0) {
            this.releaseContext();
        }
    }

    /** Frees the QuickJS context, once. */
    private releaseContext(): void {
        // while guest code is suspended on a host call, the module must stay: freeing it could crash the module.
        if (this.contextReleased || this.evalOutstanding) {
            return;
        }
        this.contextReleased = true;
        try {
            this.context.dispose();
        } catch {
            // a context left broken by a fatal error may fail to free; its module is dropped with this runtime anyway.
        }
    }

    /**
     * Frees the context of a disposed or stuck runtime once no guest code is suspended in it.
     *
     * A stuck runtime keeps its context until the evaluation that the watchdog gave up on returns, which happens
     * when its host call finally settles. A call that never settles keeps its context; that is the one case left.
     */
    private releaseIfDone(): void {
        if ((this.isDisposed || this.isStuck) && this.pendingTasks === 0) {
            this.releaseContext();
        }
    }

    /**
     * Rejects a call on a runtime that is disposed or poisoned.
     *
     * @throws SandboxRuntimeError when the runtime must not be used
     */
    private assertUsable(): void {
        if (this.isDisposed || this.isPoisoned) {
            throw new SandboxRuntimeError("runtime was discarded");
        }
    }

    /**
     * Evaluates guest source under the CPU budget of one run.
     *
     * @param source - guest source to evaluate; its value is the result when it is a string
     * @param budgetMs - guest CPU time the run may use, in milliseconds
     * @param host - host that serves the primitives during the run
     * @param deadlineAt - epoch instant in milliseconds after which the run is stopped, or undefined for none
     * @returns the string value of the source, or undefined when the value is not a string
     * @throws SandboxRuntimeError when the guest fails or exceeds a limit
     */
    private async execute(
        source: string,
        budgetMs: number,
        host: SandboxHostCalls | undefined,
        deadlineAt?: number
    ): Promise<string | undefined> {
        const run: ActiveRun = {
            startedAt: Date.now(),
            budgetMs,
            budgetExceeded: false,
            deadlineAt,
            wallExceeded: false,
        };
        this.activeRun = run;
        this.hostWaitMs = 0;
        this.host = host;
        this.evalOutstanding = true;
        let evaluated: Awaited<ReturnType<QuickJSAsyncContext["evalCodeAsync"]>>;
        try {
            evaluated = await this.context.evalCodeAsync(source, "sandbox.js");
        } finally {
            this.evalOutstanding = false;
            this.releaseIfDone();
        }
        try {
            if (evaluated.error) {
                throw this.failure(evaluated.error, run);
            }
            // the runner is synchronous, so its string is read here; no guest promise is ever settled.
            const value = this.takeResultString(evaluated.value);
            this.drainJobs(run);
            if (run.wallExceeded) {
                // the guest may have caught the wall-clock error; the abandoned host call makes the context unreliable.
                this.isPoisoned = true;
                throw new SandboxRuntimeError(SandboxRuntime.WALL_CLOCK_MESSAGE, undefined, true, "wall");
            }
            return value;
        } catch (error) {
            if (error instanceof SandboxRuntimeError) {
                throw error;
            }
            throw this.engineFailure(error);
        } finally {
            this.activeRun = undefined;
            this.host = undefined;
        }
    }

    /**
     * Converts an exception that escaped the QuickJS engine into a fatal runtime error.
     *
     * @param error - exception thrown by the engine or by the WebAssembly runtime
     * @returns the error to throw, which poisons the runtime
     */
    private engineFailure(error: unknown): SandboxRuntimeError {
        this.isPoisoned = true;
        const isStackOverflow = error instanceof RangeError && /call stack/i.test(error.message);
        const message = isStackOverflow ? "The script exceeded the call stack limit" : SandboxRuntime.messageOf(error);
        return new SandboxRuntimeError(message, undefined, true);
    }

    /**
     * Reads the string value of a guest value and disposes the handle.
     *
     * @param handle - guest value, owned and disposed by this method
     * @returns the string, or undefined when the value is not a string
     */
    private takeResultString(handle: QuickJSHandle): string | undefined {
        try {
            return this.context.typeof(handle) === "string" ? this.context.getString(handle) : undefined;
        } finally {
            handle.dispose();
        }
    }

    /**
     * Runs the pending jobs of the runtime, with host primitives refused while they run.
     *
     * The jobs are the callbacks of promises that the script made. The facade refuses such code before it runs, so
     * the jobs normally do nothing; a job that fails fails the call.
     *
     * @param run - run that owns the budget
     * @throws SandboxRuntimeError when a job fails
     */
    private drainJobs(run: ActiveRun): void {
        const jobs = this.withoutSuspend(() => this.context.runtime.executePendingJobs());
        if (jobs.error) {
            throw this.failure(jobs.error, run);
        }
        if (jobs.value > 0) {
            // a callback ran after the script ended: whatever it queued was never sent, so the call fails.
            throw new SandboxRuntimeError(
                "a promise callback ran after the script; its work was not applied. Remove then, catch and finally."
            );
        }
    }

    /**
     * Converts a guest error handle into a runtime error, and poisons the runtime on a fatal one.
     *
     * The handle is disposed by this method.
     *
     * @param errorHandle - guest error value
     * @param run - run that owns the budget
     * @returns the error to throw
     */
    private failure(errorHandle: QuickJSHandle, run: ActiveRun): SandboxRuntimeError {
        // dumping an error runs its getters, so host primitives are refused meanwhile.
        const dumped: unknown = this.withoutSuspend(() => this.context.dump(errorHandle));
        errorHandle.dispose();
        const { name, message } = SandboxRuntime.describe(dumped);
        const error = this.classify(name, message, run);
        if (error.fatal) {
            this.isPoisoned = true;
        }
        return error;
    }

    /**
     * Maps a guest error to the message and the fatal flag that the sandbox reports.
     *
     * @param name - guest error name
     * @param message - guest error message
     * @param run - run that owns the budget
     * @returns the runtime error
     */
    private classify(name: string, message: string, run: ActiveRun): SandboxRuntimeError {
        if (run.wallExceeded) {
            return new SandboxRuntimeError(SandboxRuntime.WALL_CLOCK_MESSAGE, name, true, "wall");
        }
        const isInternal = name === "InternalError";
        if (run.budgetExceeded || (isInternal && message === "interrupted")) {
            return new SandboxRuntimeError(cpuLimitMessage(run.budgetMs), name, true, "cpu");
        }
        if (isInternal && message.includes("out of memory")) {
            const megabytes = Math.round(this.memoryLimitBytes / (1024 * 1024));
            return new SandboxRuntimeError(
                `The script exceeded the ${megabytes} MB memory limit`,
                name,
                true,
                "memory"
            );
        }
        if (isInternal && message.includes("stack overflow")) {
            return new SandboxRuntimeError("The script exceeded the call stack limit", name, false, "stack");
        }
        return new SandboxRuntimeError(message, name, false);
    }

    /**
     * Decides whether the interrupt handler stops the run in progress.
     *
     * Host time is excluded from the elapsed time. The handler stops the run once the guest CPU time exceeds its budget.
     * The wall-clock deadline is checked first, and it counts host time too.
     *
     * @returns true when the run must be interrupted
     */
    private shouldInterrupt(): boolean {
        const run = this.activeRun;
        if (run === undefined) {
            // guest code runs outside a call only through a bug or a tampered global; stop it.
            return true;
        }
        if (run.deadlineAt !== undefined && Date.now() >= run.deadlineAt) {
            run.wallExceeded = true;
            return true;
        }
        const cpuMs = Date.now() - run.startedAt - this.hostWaitMs;
        if (cpuMs > run.budgetMs) {
            run.budgetExceeded = true;
            return true;
        }
        return false;
    }

    /**
     * Extracts the name and the message of a dumped guest error.
     *
     * @param dumped - value returned by the context dump
     * @returns the error name and message
     */
    private static describe(dumped: unknown): { name: string; message: string } {
        if (typeof dumped === "object" && dumped !== null) {
            const record = dumped as { name?: unknown; message?: unknown };
            return {
                name: typeof record.name === "string" ? record.name : "Error",
                message: typeof record.message === "string" ? record.message : String(dumped),
            };
        }
        return { name: "Error", message: String(dumped) };
    }

    /**
     * Returns the text of an unknown thrown value.
     *
     * @param error - thrown value
     * @returns the message of an Error, or the string form of any other value
     */
    private static messageOf(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
