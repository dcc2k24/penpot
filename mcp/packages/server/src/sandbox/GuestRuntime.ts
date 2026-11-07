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

/** A limit of the sandbox that can stop a call. */
export type SandboxLimit = "cpu" | "wall" | "memory" | "stack";

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
     * @param limit - the limit that stopped the call, when a limit did
     */
    constructor(
        message: string,
        public readonly guestName?: string,
        public readonly fatal: boolean = false,
        public readonly limit?: SandboxLimit
    ) {
        super(message);
        this.name = "SandboxRuntimeError";
    }
}

/** Message of the error of a call on a runtime that was discarded before the call started. */
export const RUNTIME_DISCARDED_MESSAGE = "runtime was discarded";

/** Message of the error that a run raises once its wall-clock deadline has passed. */
export const WALL_CLOCK_MESSAGE = "The script exceeded the wall-clock time limit";

/** Milliseconds a watchdog waits past the deadline when no host write is in flight. */
export const WATCHDOG_GRACE_MS = 2_000;

/** Milliseconds a watchdog waits past the deadline while a host write is in flight. */
export const WATCHDOG_WRITE_GRACE_MS = 90_000;

/** Memory budget of a guest when none is given, in bytes. */
export const DEFAULT_GUEST_MEMORY_BYTES = 128 * 1024 * 1024;

/**
 * Message of the CPU-limit error for a budget.
 *
 * @param budgetMs - guest CPU budget, in milliseconds
 * @returns the text shown to the user
 */
export function cpuLimitMessage(budgetMs: number): string {
    const seconds = Math.round(budgetMs / 100) / 10;
    return `The script exceeded the ${seconds} s CPU limit`;
}

/** Host primitives that change data. The guest waits for them, and the watchdog waits while one is in flight. */
export const WRITE_PRIMITIVES: ReadonlySet<HostPrimitiveName> = new Set<HostPrimitiveName>([
    "flush",
    "importSvg",
    "rpc",
    "uploadMediaUrl",
    "uploadMediaData",
]);

/** Names of the host primitives installed on the global `__host` object. */
export const HOST_PRIMITIVE_NAMES = [
    "loadFileOutline",
    "loadPage",
    "flush",
    "importSvg",
    "rpc",
    "exportShape",
    "uploadMediaUrl",
    "uploadMediaData",
] as const;

/** Name of one host primitive reachable from guest code. */
export type HostPrimitiveName = (typeof HOST_PRIMITIVE_NAMES)[number];

/** Options of one call of {@link GuestRuntime.invoke}. */
export interface InvokeOptions {
    /**
     * Wall-clock limit of the call, in milliseconds. The clock starts when the call starts to run, not when it
     * is queued behind other calls of the same runtime.
     */
    wallMs?: number;
    /** Called once the call starts to run, with the epoch instant at which its wall-clock limit ends. */
    onStart?: (deadlineAt: number) => void;
    /** Milliseconds the watchdog waits past the deadline when no host write is in flight. */
    graceMs?: number;
    /** Milliseconds the watchdog waits past the deadline while a host write is in flight. */
    writeGraceMs?: number;
    /**
     * Extra milliseconds that the watchdog allows the writes still in flight, read each time it checks. The
     * host sets it from the calls left in its flush, so a long flush is not reported as stuck while it commits.
     */
    writeAllowanceMs?: () => number;
    /** Refuses the host calls of the call: each one gets a synchronous error, so no host work starts. */
    refuseHost?: boolean;
    /** Called when the watchdog abandons the call, so that the host stops the work the call started. */
    onAbandon?: () => void;
}

/**
 * A guest runtime: runs scripts in one QuickJS context that belongs to one MCP session.
 *
 * Two implementations exist: {@link SandboxRuntime}, which runs the context on the main thread, and
 * `SandboxWorkerRuntime`, which runs it in a worker thread that the main thread can terminate.
 */
export interface GuestRuntime {
    /** Whether the runtime was disposed. */
    readonly disposed: boolean;
    /** Whether a fatal error made the runtime unusable. */
    readonly poisoned: boolean;
    /** Whether the runtime is idle and its WebAssembly memory grew past the recycle size. */
    readonly spent: boolean;
    /** Current size of the WebAssembly memory of the runtime, in bytes. It never shrinks. */
    readonly wasmMemoryBytes: number;
    /**
     * Last saved text of `storage`, as JSON, or undefined when the runtime keeps storage only in the guest.
     * A runtime that is replaced takes its saved storage to the next one with {@link restoreStorage}.
     */
    readonly storageSnapshot: string | undefined;
    /**
     * Sets the text of `storage` that the next call starts with.
     *
     * @param text - storage as JSON text
     */
    restoreStorage(text: string): void;
    /**
     * Calls a global guest function with string arguments.
     *
     * @param functionName - name of a global guest function
     * @param stringArgs - arguments passed to the function
     * @param host - host that serves the host primitives during this call
     * @param budgetMs - guest CPU time the call may use, in milliseconds
     * @param options - wall-clock limit, start hook and watchdog grace of the call
     * @returns the string the function returned
     * @throws SandboxRuntimeError when the guest fails, exceeds a limit or returns a non-string value
     */
    invoke(
        functionName: string,
        stringArgs: string[],
        host: SandboxHostCalls,
        budgetMs: number,
        options?: InvokeOptions
    ): Promise<string>;
    /**
     * Takes the note the runtime made for the last call, such as storage that was not saved, and clears it.
     *
     * @returns the note, or undefined when there is none
     */
    takeNotice(): string | undefined;
    /** Releases the runtime. Calling this more than once has no effect. */
    dispose(): void;
}
