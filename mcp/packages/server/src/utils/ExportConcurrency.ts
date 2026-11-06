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

    /**
     * Runs a backend export task through the backend gate, which defaults to four concurrent exports.
     *
     * @param task - the export to run
     * @returns the value that the task resolves to
     */
    public static withBackendPermit<T>(task: () => Promise<T>): Promise<T> {
        if (ExportConcurrency.backendSemaphore === undefined) {
            return task();
        }
        return ExportConcurrency.backendSemaphore.withPermit(task);
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
}
