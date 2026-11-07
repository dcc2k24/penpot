import { createLogger } from "../logger";
import { Semaphore } from "./Semaphore";

/**
 * Process-wide gate for image exports in multi-user mode.
 *
 * The bound comes from the PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS environment variable and is read once.
 * Zero, or a missing value, means no limit. Both the bridge and the backend export tools pass their work
 * through this gate, so the bound applies across all sessions of the process.
 */
export class ExportConcurrency {
    /**
     * Maximum number of export operations that may run concurrently in multi-user mode.
     *
     * When set to a positive value (and combined with the plugin-side per-response cap
     * MAX_TASK_RESPONSE_SIZE_REMOTE_MCP, ~15 MB JSON), this caps the in-flight memory
     * footprint of image exports at roughly N x cap on the centrally hosted MCP server.
     */
    private static readonly maximum = parseInt(process.env.PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS ?? "0", 10);

    /**
     * Gates concurrent export operations across all tool instances (one per session in
     * multi-user mode). Static because instances are per-session, but the bound has to
     * apply across the whole process. Permits beyond the maximum queue in FIFO order.
     * Undefined when the maximum is non-positive, indicating no limit.
     */
    private static readonly semaphore: Semaphore | undefined =
        ExportConcurrency.maximum > 0 ? new Semaphore("ExportShapeTool", ExportConcurrency.maximum) : undefined;

    static {
        createLogger("ExportShapeTool").info(
            "Max parallel exports (multi-user mode): %d (0 = unbounded)",
            ExportConcurrency.maximum
        );
    }

    /** Default number of concurrent backend exports. */
    private static readonly DEFAULT_BACKEND_MAXIMUM = 4;

    /** Renders a token may hold at once. One token cannot take every backend export slot. */
    public static readonly RENDERS_PER_TOKEN = 1;

    /** Time a backend render may run before its caller gets an error and its permits are freed, in milliseconds. */
    public static readonly RENDER_TIMEOUT_MS = 60_000;

    /**
     * Bound of the backend export gate. Backend mode defaults to 4 concurrent exports; the variable
     * PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS overrides it, and zero means no limit.
     */
    private static readonly backendMaximum = ExportConcurrency.readBackendMaximum(process.env);

    /** Gate of the backend export tools, separate from the bridge gate so that bridge behaviour is unchanged. */
    private static readonly backendSemaphore: Semaphore | undefined =
        ExportConcurrency.backendMaximum > 0
            ? new Semaphore("ExportShapeBackendTool", ExportConcurrency.backendMaximum)
            : undefined;

    /** Per-token gates that hold at least one render, keyed by token digest. Dropped again when idle. */
    private static readonly tokenGates = new Map<string, { gate: Semaphore; holders: number }>();

    /**
     * Runs a backend render under the permits of its token and of the process.
     *
     * A token gets {@link RENDERS_PER_TOKEN} render at a time, and the process runs at most the backend maximum
     * at once. The task is held to the render timeout. At the deadline its signal is aborted, so that the render
     * stops and does not keep loading the exporter, and the caller gets an error.
     *
     * @param tokenDigest - digest of the MCP token of the request, never the raw token
     * @param task - the render to run; it receives the signal that fires at the deadline and should pass it on
     * @param timeoutMs - the time the task may run, in milliseconds; defaults to {@link RENDER_TIMEOUT_MS}
     * @returns the value that the task resolves to
     * @throws Error when the task runs longer than the timeout, or fails
     */
    public static async withBackendPermit<T>(
        tokenDigest: string,
        task: (signal: AbortSignal) => Promise<T>,
        timeoutMs: number = ExportConcurrency.RENDER_TIMEOUT_MS
    ): Promise<T> {
        const entry = ExportConcurrency.holdTokenGate(tokenDigest);
        try {
            return await entry.gate.withPermit(() => ExportConcurrency.runWithProcessPermit(task, timeoutMs));
        } finally {
            ExportConcurrency.releaseTokenGate(tokenDigest, entry);
        }
    }

    /**
     * Reads the backend export bound from the environment.
     *
     * @param env - the environment to read
     * @returns the bound, 4 when the variable is unset or blank, zero for no limit
     */
    public static readBackendMaximum(env: Record<string, string | undefined>): number {
        const raw = env.PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS?.trim();
        if (raw === undefined || raw === "") {
            return ExportConcurrency.DEFAULT_BACKEND_MAXIMUM;
        }
        const value = parseInt(raw, 10);
        return Number.isFinite(value) && value >= 0 ? value : ExportConcurrency.DEFAULT_BACKEND_MAXIMUM;
    }

    /**
     * Runs an export task through the shared gate, or directly when no limit is configured.
     *
     * @param task - the export to run
     * @returns the value that the task resolves to
     */
    public static withPermit<T>(task: () => Promise<T>): Promise<T> {
        if (ExportConcurrency.semaphore === undefined) {
            return task();
        }
        return ExportConcurrency.semaphore.withPermit(task);
    }

    /**
     * Returns the gate of a token, creating it when the token has none, and counts the caller as a holder.
     *
     * @param tokenDigest - digest of the MCP token
     */
    private static holdTokenGate(tokenDigest: string): { gate: Semaphore; holders: number } {
        let entry = ExportConcurrency.tokenGates.get(tokenDigest);
        if (entry === undefined) {
            entry = {
                gate: new Semaphore(`ExportToken:${tokenDigest.slice(0, 12)}`, ExportConcurrency.RENDERS_PER_TOKEN),
                holders: 0,
            };
            ExportConcurrency.tokenGates.set(tokenDigest, entry);
        }
        entry.holders += 1;
        return entry;
    }

    /**
     * Stops counting a holder of a token gate, and drops the gate when no holder is left.
     *
     * @param tokenDigest - digest of the MCP token
     * @param entry - the gate the holder was given
     */
    private static releaseTokenGate(tokenDigest: string, entry: { holders: number }): void {
        entry.holders -= 1;
        if (entry.holders === 0 && ExportConcurrency.tokenGates.get(tokenDigest) === entry) {
            ExportConcurrency.tokenGates.delete(tokenDigest);
        }
    }

    /**
     * Runs a task under the process-wide backend permit, when there is a bound, with the render timeout.
     *
     * @param task - the render to run
     * @param timeoutMs - the time the task may run, in milliseconds
     */
    private static runWithProcessPermit<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
        const timed = () => ExportConcurrency.withDeadline(task, timeoutMs);
        if (ExportConcurrency.backendSemaphore === undefined) {
            return timed();
        }
        return ExportConcurrency.backendSemaphore.withPermit(timed);
    }

    /**
     * Runs a task and rejects when it does not settle within the time. At the deadline the signal that the task
     * receives is aborted, so the work it started can stop.
     *
     * @param task - the work to run; it receives the signal that fires at the deadline
     * @param timeoutMs - the time allowed, in milliseconds
     */
    private static withDeadline<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                const error = new Error(`The export did not finish within ${timeoutMs / 1000} seconds.`);
                controller.abort(error);
                reject(error);
            }, timeoutMs);
        });
        return Promise.race([task(controller.signal), deadline]).finally(() => {
            clearTimeout(timer);
        });
    }
}
