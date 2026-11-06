import {
    newQuickJSAsyncWASMModule,
    newVariant,
    RELEASE_ASYNC,
    type ExecutePendingJobsResult,
    type QuickJSAsyncContext,
    type QuickJSHandle,
} from "quickjs-emscripten";

/** Host operations that guest code reaches through the global `__host` object. */
export interface SandboxHostCalls {
    /** Loads the outline of a file as JSON text. */
    loadFileOutline(fileId: string): Promise<string>;
    /** Loads one page of a file as JSON text. */
    loadPage(fileId: string, pageId: string): Promise<string>;
    /** Applies a list of operations to a file, as JSON text, optionally without saving. */
    flush(fileId: string, operationsJson: string, dryRun: boolean): Promise<string>;
    /** Imports an SVG document, described by JSON text, and returns the result as JSON text. */
    importSvg(paramsJson: string): Promise<string>;
    /** Calls a backend RPC command with JSON parameters and returns its JSON result. */
    rpc(name: string, paramsJson: string): Promise<string>;
    /** Renders a shape or a page, described by JSON text, and returns `{ mimeType, base64 }` as JSON text. */
    exportShape(paramsJson: string): Promise<string>;
    /** Stores an image from a URL in the media library of a file, and returns the media object as JSON text. */
    uploadMediaUrl(paramsJson: string): Promise<string>;
    /** Stores image bytes, described by JSON text with base64 content, in the media library of a file. */
    uploadMediaData(paramsJson: string): Promise<string>;
}

/** Limits of one guest context. */
export interface SandboxRuntimeOptions {
    /** Memory budget of the guest, in bytes. It also words the out-of-memory error. */
    memoryLimitBytes?: number;
    /** Call stack limit of the guest, in bytes. */
    stackSizeBytes?: number;
    /** Most bytes the WebAssembly memory of the runtime may grow to. Default: twice the memory budget. */
    wasmMemoryLimitBytes?: number;
    /**
     * WebAssembly memory size, in bytes, above which an idle runtime counts as spent and should be replaced.
     * Default: the memory budget.
     */
    recycleAboveBytes?: number;
}

/**
 * Error raised by a guest script or by the sandbox limits.
 *
 * A fatal error means the guest context is no longer reliable and must be discarded.
 */
export class SandboxRuntimeError extends Error {
    /**
     * Creates a runtime error.
     *
     * @param message - text shown to the user
     * @param guestName - name of the guest error, such as `TypeError`, when the error came from guest code
     * @param fatal - whether the guest context must be discarded
     */
    constructor(
        message: string,
        public readonly guestName?: string,
        public readonly fatal: boolean = false
    ) {
        super(message);
        this.name = "SandboxRuntimeError";
    }
}

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

/** Name of one host primitive reachable from guest code. */
type HostPrimitiveName = (typeof SandboxRuntime.HOST_PRIMITIVE_NAMES)[number];

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
 * stack until its promise settles, so guest code calls `__host.*` as ordinary functions and never awaits.
 * Host primitives called after an `await` inside guest code corrupt the module, so the facade never
 * returns promises and user scripts that use `await` are rejected with a hint.
 *
 * Each runtime owns its own WebAssembly module instance, whose memory has a fixed maximum. The memory of a
 * WebAssembly instance never shrinks, so a runtime whose memory grew past the recycle size is spent once idle:
 * the owner should dispose it and drop every reference, so that the instance and its memory can be collected.
 * The QuickJS memory limit alone does not bound the heap in this build, because it counts a few bytes per block
 * whatever the block size; the maximum of the WebAssembly memory is the limit that holds.
 */
export class SandboxRuntime {
    /** Names of the host primitives installed on the global `__host` object. */
    public static readonly HOST_PRIMITIVE_NAMES = [
        "loadFileOutline",
        "loadPage",
        "flush",
        "importSvg",
        "rpc",
        "exportShape",
        "uploadMediaUrl",
        "uploadMediaData",
    ] as const;
    /** Default memory budget of the guest, in bytes. */
    private static readonly DEFAULT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
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
    private static readonly WALL_CLOCK_MESSAGE = "The script exceeded the wall-clock time limit";
    /** Runtimes that have been created and not yet disposed. */
    private static readonly live = new Set<SandboxRuntime>();
    /** Size of one WebAssembly memory page, in bytes. */
    private static readonly WASM_PAGE_BYTES = 65_536;
    /** Initial size of the WebAssembly memory, in bytes, which the QuickJS build expects. */
    private static readonly WASM_INITIAL_BYTES = 16 * 1024 * 1024;

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
    /** Whether the pending jobs are running, where host primitives cannot suspend the guest. */
    private runningJobs = false;

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
     * Creates a sandbox in a new WebAssembly module instance and evaluates the prelude in it.
     *
     * @param prelude - guest source evaluated once, which defines the functions that `invoke` calls
     * @param options - memory and stack limits of the guest
     * @returns the ready runtime
     * @throws SandboxRuntimeError when the prelude fails
     */
    public static async create(prelude: string, options: SandboxRuntimeOptions = {}): Promise<SandboxRuntime> {
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
            await runtime.execute(prelude, SandboxRuntime.PRELUDE_BUDGET_MS, undefined, false);
        } catch (error) {
            runtime.dispose();
            throw error;
        }
        SandboxRuntime.live.add(runtime);
        return runtime;
    }

    /**
     * Counts the runtimes that have been created and not yet disposed.
     *
     * @returns the number of live runtimes
     */
    public static liveCount(): number {
        return SandboxRuntime.live.size;
    }

    /** Whether the runtime was disposed. */
    public get disposed(): boolean {
        return this.isDisposed;
    }

    /** Whether a fatal error made the runtime unusable. */
    public get poisoned(): boolean {
        return this.isPoisoned;
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
     * The function may return a string or a promise of a string. Calls run in FIFO order.
     *
     * @param functionName - name of a global guest function
     * @param stringArgs - arguments passed to the function
     * @param host - host that serves the host primitives during this call
     * @param budgetMs - guest CPU time the call may use, in milliseconds
     * @param deadlineAt - epoch instant in milliseconds after which the call is stopped, or undefined for no
     *   wall-clock limit
     * @returns the string the function returned
     * @throws SandboxRuntimeError when the guest fails, exceeds a limit or returns a non-string value
     */
    public invoke(
        functionName: string,
        stringArgs: string[],
        host: SandboxHostCalls,
        budgetMs: number,
        deadlineAt?: number
    ): Promise<string> {
        if (!SandboxRuntime.IDENTIFIER.test(functionName)) {
            return Promise.reject(new Error(`"${functionName}" is not a valid function name.`));
        }
        return this.enqueue(async () => {
            this.assertUsable();
            this.bindArguments(stringArgs);
            const argumentNames = stringArgs.map((_, index) => `__arg${index}`).join(", ");
            const source = `Promise.resolve(${functionName}(${argumentNames}));`;
            const result = await this.execute(source, budgetMs, host, true, deadlineAt);
            if (result === undefined) {
                throw new SandboxRuntimeError("The script must return a string.");
            }
            return result;
        });
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
        if (this.runningJobs) {
            const error = this.context.newError("host primitives cannot be called after an await");
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
            return { error: this.context.newError(SandboxRuntime.messageOf(error)) };
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
        try {
            if (run !== undefined && run.deadlineAt !== undefined && started >= run.deadlineAt) {
                run.wallExceeded = true;
                throw new Error(SandboxRuntime.WALL_CLOCK_MESSAGE);
            }
            const hostCall = this.invokeHost(host, name, args);
            const result: unknown = await this.untilDeadline(hostCall, run);
            if (typeof result !== "string") {
                throw new Error(`${name} must resolve to a string.`);
            }
            return result;
        } finally {
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
        const value: unknown = arg === undefined ? undefined : this.context.dump(arg);
        if (typeof value !== "boolean") {
            throw new Error(`argument ${index + 1} must be a boolean.`);
        }
        return value;
    }

    /**
     * Stores the string arguments as the globals `__arg0`, `__arg1`, and so on.
     *
     * @param args - values to store
     */
    private bindArguments(args: string[]): void {
        for (let index = 0; index < args.length; index++) {
            const handle = this.context.newString(args[index]);
            this.context.setProp(this.context.global, `__arg${index}`, handle);
            handle.dispose();
        }
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
        if (this.contextReleased) {
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
     * @param source - guest source to evaluate
     * @param budgetMs - guest CPU time the run may use, in milliseconds
     * @param host - host that serves the primitives during the run
     * @param settle - whether the value is a promise whose settled string is the result
     * @param deadlineAt - epoch instant in milliseconds after which the run is stopped, or undefined for none
     * @returns the string the promise settled with, or undefined when the value is not a string or `settle` is false
     * @throws SandboxRuntimeError when the guest fails or exceeds a limit
     */
    private async execute(
        source: string,
        budgetMs: number,
        host: SandboxHostCalls | undefined,
        settle: boolean,
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
        try {
            const evaluated = await this.context.evalCodeAsync(source, "sandbox.js");
            if (evaluated.error) {
                throw this.failure(evaluated.error, run);
            }
            if (!settle) {
                evaluated.value.dispose();
                return undefined;
            }
            const value = await this.settle(evaluated.value, run);
            if (run.wallExceeded) {
                // the guest may have caught the wall-clock error; the abandoned host call makes the context unreliable.
                this.isPoisoned = true;
                throw new SandboxRuntimeError(SandboxRuntime.WALL_CLOCK_MESSAGE, undefined, true);
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
     * Runs the pending jobs until a guest promise settles, and reads its string value.
     *
     * @param promiseHandle - guest promise, owned and disposed by this method
     * @param run - run that owns the budget
     * @returns the string value, or undefined when the value is not a string
     * @throws SandboxRuntimeError when the promise rejects, the jobs fail, or the promise never settles
     */
    private async settle(promiseHandle: QuickJSHandle, run: ActiveRun): Promise<string | undefined> {
        try {
            // The host promise must be created before the jobs run, or it never resolves.
            const outcome = this.context.resolvePromise(promiseHandle);
            const jobs = this.runJobs();
            if (jobs.error) {
                throw this.failure(jobs.error, run);
            }
            if (this.context.getPromiseState(promiseHandle).type === "pending") {
                throw new SandboxRuntimeError("The script finished without settling its promise.");
            }
            const settled = await outcome;
            if (settled.error) {
                throw this.failure(settled.error, run);
            }
            try {
                return this.context.typeof(settled.value) === "string"
                    ? this.context.getString(settled.value)
                    : undefined;
            } finally {
                settled.value.dispose();
            }
        } finally {
            promiseHandle.dispose();
        }
    }

    /**
     * Runs the pending jobs of the runtime, with host primitives refused while they run.
     *
     * @returns the result of the job run
     */
    private runJobs(): ExecutePendingJobsResult {
        this.runningJobs = true;
        try {
            return this.context.runtime.executePendingJobs();
        } finally {
            this.runningJobs = false;
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
        const dumped: unknown = this.context.dump(errorHandle);
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
            return new SandboxRuntimeError(SandboxRuntime.WALL_CLOCK_MESSAGE, name, true);
        }
        const isInternal = name === "InternalError";
        if (run.budgetExceeded || (isInternal && message === "interrupted")) {
            const seconds = Math.round(run.budgetMs / 100) / 10;
            return new SandboxRuntimeError(`The script exceeded the ${seconds} s CPU limit`, name, true);
        }
        if (isInternal && message.includes("out of memory")) {
            const megabytes = Math.round(this.memoryLimitBytes / (1024 * 1024));
            return new SandboxRuntimeError(`The script exceeded the ${megabytes} MB memory limit`, name, true);
        }
        if (isInternal && message.includes("stack overflow")) {
            return new SandboxRuntimeError("The script exceeded the call stack limit", name, false);
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
            return false;
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
