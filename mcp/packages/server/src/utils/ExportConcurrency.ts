import { createLogger } from "../logger";
import { PermitGate } from "./PermitGate";
import { Semaphore } from "./Semaphore";
import type { SharedExportPermits } from "./RedisExportPermits";

/** Options of one backend export: how long the whole call may take, and how long it may wait for a slot. */
export interface BackendPermitOptions {
    /** Longest time for the whole call, queue wait and render together, in milliseconds. */
    timeoutMs?: number;
    /** Longest time to wait for a render slot, in milliseconds. */
    waitMs?: number;
}

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

    /** Default number of concurrent backend exports. */
    private static readonly DEFAULT_BACKEND_MAXIMUM = 4;

    /** Renders a token may hold at once. One token cannot take every backend export slot. */
    public static readonly RENDERS_PER_TOKEN = 1;

    /** Longest time a backend export may take in all, queue wait and render together, in milliseconds. */
    public static readonly RENDER_TIMEOUT_MS = 60_000;

    /**
     * How long a shared export permit stays held if its holder never gives it back, in milliseconds. It exceeds
     * the render timeout, so a permit cannot expire while its render still runs.
     */
    public static readonly PERMIT_LEASE_MS = ExportConcurrency.RENDER_TIMEOUT_MS + 5_000;

    /** Longest time a backend export waits for a render slot before it is refused as busy, in milliseconds. */
    public static readonly PERMIT_WAIT_MS = 30_000;

    /**
     * Bound of the backend export gate. Backend mode defaults to 4 concurrent exports; the variable
     * PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS overrides it, and zero means no limit.
     */
    private static readonly backendMaximum = ExportConcurrency.readBackendMaximum(process.env);

    /**
     * Process-wide slots of the backend export tools, separate from the bridge gate so that bridge behaviour is
     * unchanged. Undefined when the bound is zero, which means no limit.
     */
    private static readonly backendGate: PermitGate | undefined =
        ExportConcurrency.backendMaximum > 0 ? new PermitGate("export", ExportConcurrency.backendMaximum) : undefined;

    /**
     * Permits shared by all adapters that use one Redis, taken after the process permit. Undefined when no
     * shared store is configured. Set by {@link setSharedPermits}.
     */
    private static sharedPermits: SharedExportPermits | undefined;

    static {
        const log = createLogger("ExportShapeTool");
        log.info("Max parallel exports (bridge): %d (0 = unbounded)", ExportConcurrency.maximum);
        log.info(
            "Max parallel exports (backend mode, per process): %s",
            ExportConcurrency.backendMaximum === 0 ? "0 (unbounded)" : ExportConcurrency.backendMaximum
        );
    }

    /**
     * Sets the shared permits that every backend render takes after its process permit.
     *
     * @param permits - the shared permits, or undefined to take none
     */
    public static setSharedPermits(permits: SharedExportPermits | undefined): void {
        ExportConcurrency.sharedPermits = permits;
    }

    /** Per-token gates that hold at least one call, keyed by token digest. Dropped again when idle. */
    private static readonly tokenGates = new Map<string, { gate: PermitGate; holders: number }>();

    /**
     * Runs a backend export under the slot of its token and the slot of the process.
     *
     * A token gets {@link RENDERS_PER_TOKEN} render at a time, and the process runs at most the backend maximum at
     * once. The timeout covers the whole call, the wait for slots and the render. At the deadline the signal that
     * the render receives is aborted and the slots are given back, so the exporter load is bounded even when the
     * render does not stop at once. A call that waits too long for a slot is refused with a busy error.
     *
     * @param tokenDigest - digest of the MCP token of the request, never the raw token
     * @param task - the render to run; it receives the signal that fires at the deadline and should pass it on
     * @param options - the total time and the slot wait, both in milliseconds; defaults are the constants above
     * @returns the value that the task resolves to
     * @throws Error with the busy text when no slot is free in time, or when the call runs past its timeout
     */
    public static async withBackendPermit<T>(
        tokenDigest: string,
        task: (signal: AbortSignal) => Promise<T>,
        options: BackendPermitOptions = {}
    ): Promise<T> {
        const timeoutMs = options.timeoutMs ?? ExportConcurrency.RENDER_TIMEOUT_MS;
        const waitMs = options.waitMs ?? ExportConcurrency.PERMIT_WAIT_MS;
        const entry = ExportConcurrency.holdTokenGate(tokenDigest);
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort(new Error(`The export did not finish within ${timeoutMs / 1000} seconds.`));
        }, timeoutMs);
        try {
            return await ExportConcurrency.runGated(entry.gate, task, { waitMs, signal: controller.signal });
        } finally {
            clearTimeout(timer);
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
     * Takes the token slot, then the process slot, then the shared permit, runs the task, and gives them back in
     * reverse order.
     *
     * The task races the deadline signal, so the slots are given back at the deadline even when the task ignores the
     * signal. The token slot is taken first, so that a token with many waiting calls does not hold process slots
     * while it waits. The shared permit waits for what is left of the wait budget.
     *
     * @param tokenGate - the gate of the token of the call
     * @param task - the render to run
     * @param wait - the slot wait, and the deadline signal
     */
    private static async runGated<T>(
        tokenGate: PermitGate,
        task: (signal: AbortSignal) => Promise<T>,
        wait: { waitMs: number; signal: AbortSignal }
    ): Promise<T> {
        const startedAt = Date.now();
        const run = () => Promise.race([task(wait.signal), ExportConcurrency.abortedAsRejection(wait.signal)]);
        await tokenGate.acquire(wait);
        try {
            const processGate = ExportConcurrency.backendGate;
            if (processGate === undefined) {
                return await ExportConcurrency.runShared(run, wait, startedAt);
            }
            await processGate.acquire(wait);
            try {
                return await ExportConcurrency.runShared(run, wait, startedAt);
            } finally {
                processGate.release();
            }
        } finally {
            tokenGate.release();
        }
    }

    /**
     * Takes the shared permit when one is configured, runs the task, and gives the permit back.
     *
     * @param run - the render to run
     * @param wait - the wait budget and the signal
     * @param startedAt - the time, in milliseconds, at which the call started to wait for slots
     */
    private static async runShared<T>(
        run: () => Promise<T>,
        wait: { waitMs: number; signal: AbortSignal },
        startedAt: number
    ): Promise<T> {
        const shared = ExportConcurrency.sharedPermits;
        if (shared === undefined) {
            return run();
        }
        const remainingMs = Math.max(0, wait.waitMs - (Date.now() - startedAt));
        const release = await shared.acquire({ waitMs: remainingMs, signal: wait.signal });
        try {
            return await run();
        } finally {
            await release();
        }
    }

    /**
     * Returns a promise that rejects with the reason of a signal once the signal fires.
     *
     * @param signal - the signal to watch
     */
    private static abortedAsRejection(signal: AbortSignal): Promise<never> {
        return new Promise<never>((_resolve, reject) => {
            const fail = (): void => reject(signal.reason);
            if (signal.aborted) {
                fail();
            } else {
                signal.addEventListener("abort", fail, { once: true });
            }
        });
    }

    /**
     * Returns the gate of a token, creating it when the token has none, and counts the caller as a holder.
     *
     * @param tokenDigest - digest of the MCP token
     */
    private static holdTokenGate(tokenDigest: string): { gate: PermitGate; holders: number } {
        let entry = ExportConcurrency.tokenGates.get(tokenDigest);
        if (entry === undefined) {
            entry = { gate: new PermitGate("export", ExportConcurrency.RENDERS_PER_TOKEN), holders: 0 };
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
}
