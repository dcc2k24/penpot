/** Tunables of the sandbox runtime behind `execute_code`, read from the environment. */
export class SandboxSettings {
    /**
     * Default guest CPU time of one call, in milliseconds.
     *
     * The budget is 3 s. The guest runs in a worker thread, so a long run no longer holds up the server; a larger
     * value is an operator choice.
     */
    public static readonly DEFAULT_CPU_BUDGET_MS = 3_000;
    /** Default idle time after which a session sandbox is evicted, in milliseconds. */
    public static readonly DEFAULT_IDLE_EVICT_MS = 30 * 60 * 1000;
    /** Default wall-clock limit of one call, in milliseconds. */
    public static readonly DEFAULT_WALL_MS = 120_000;
    /** Default most host primitive calls one script may make. */
    public static readonly DEFAULT_MAX_HOST_CALLS = 1000;
    /** Default most live sandbox runtimes. */
    public static readonly DEFAULT_MAX_SESSIONS = 20;
    /** Default most calls that run at once. */
    public static readonly DEFAULT_MAX_CONCURRENT_CALLS = SandboxSettings.DEFAULT_MAX_SESSIONS;
    /** Default time a queued call waits for a free slot, in milliseconds. */
    public static readonly DEFAULT_SLOT_WAIT_MS = 60_000;
    /** Default: each guest runs in a worker thread. `PENPOT_MCP_SANDBOX_WORKERS=false` runs them on the main thread. */
    public static readonly DEFAULT_WORKERS = true;
    /**
     * Default most page data one call may hold, in MB of JSON. The guest parses each page as JSON inside a 256 MB
     * WebAssembly memory, and a parsed page takes several times its JSON size. At 16 MB the parsed page and the
     * script's own data fit in that memory; a larger page needs a larger setting and a bigger memory.
     */
    public static readonly DEFAULT_MAX_PAGE_MB = 16;
    /**
     * Default host time of one script, in milliseconds: the wall time it spends in backend and exporter calls,
     * rate-limit waits included. A script that reads in a flood ends here with a clear error.
     */
    public static readonly DEFAULT_MAX_HOST_MS = 30_000;
    /** Environment variable that sets the host time of one script, in milliseconds. */
    public static readonly HOST_MS_VARIABLE = "PENPOT_MCP_SANDBOX_HOST_MS";
    /** Environment variable that sets the most page data one call may hold, in MB of JSON. */
    public static readonly PAGE_MB_VARIABLE = "PENPOT_MCP_SANDBOX_PAGE_MB";
    /** Environment variable that switches the worker threads on or off. */
    public static readonly WORKERS_VARIABLE = "PENPOT_MCP_SANDBOX_WORKERS";

    /**
     * Creates settings from explicit values.
     *
     * @param cpuBudgetMs - guest CPU time one call may use, in milliseconds
     * @param idleEvictMs - idle time after which a session sandbox is disposed, in milliseconds
     * @param wallMs - wall-clock limit of one call, in milliseconds
     * @param maxHostCalls - most host primitive calls one script may make
     * @param maxSessions - most live sandbox runtimes
     * @param maxConcurrentCalls - most calls that may run at once
     * @param slotWaitMs - time a queued call waits for a free slot, in milliseconds
     * @param workers - whether each guest runs in a worker thread
     */
    constructor(
        public readonly cpuBudgetMs: number = SandboxSettings.DEFAULT_CPU_BUDGET_MS,
        public readonly idleEvictMs: number = SandboxSettings.DEFAULT_IDLE_EVICT_MS,
        public readonly wallMs: number = SandboxSettings.DEFAULT_WALL_MS,
        public readonly maxHostCalls: number = SandboxSettings.DEFAULT_MAX_HOST_CALLS,
        public readonly maxSessions: number = SandboxSettings.DEFAULT_MAX_SESSIONS,
        public readonly maxConcurrentCalls: number = SandboxSettings.DEFAULT_MAX_CONCURRENT_CALLS,
        public readonly slotWaitMs: number = SandboxSettings.DEFAULT_SLOT_WAIT_MS,
        public readonly workers: boolean = SandboxSettings.DEFAULT_WORKERS,
        public readonly maxPageBytes: number = SandboxSettings.DEFAULT_MAX_PAGE_MB * 1024 * 1024,
        public readonly maxHostMs: number = SandboxSettings.DEFAULT_MAX_HOST_MS
    ) {}

    /**
     * Tells whether guests run in worker threads, according to the environment.
     *
     * @param env - environment to read
     * @returns true unless `PENPOT_MCP_SANDBOX_WORKERS` is set to a false value
     * @throws Error naming the variable when the value is neither true nor false
     */
    public static workersEnabled(env: Record<string, string | undefined>): boolean {
        return SandboxSettings.flag(env, SandboxSettings.WORKERS_VARIABLE, SandboxSettings.DEFAULT_WORKERS);
    }

    /**
     * Reads the sandbox settings from environment variables.
     *
     * @param env - environment to read
     * @throws Error naming the variable when a value is malformed
     */
    public static fromEnvironment(env: Record<string, string | undefined>): SandboxSettings {
        const timeoutSeconds = SandboxSettings.positiveNumber(
            env,
            "PENPOT_MCP_SANDBOX_TIMEOUT_S",
            SandboxSettings.DEFAULT_CPU_BUDGET_MS / 1000
        );
        const idleMinutes = SandboxSettings.positiveNumber(
            env,
            "PENPOT_MCP_SANDBOX_IDLE_MIN",
            SandboxSettings.DEFAULT_IDLE_EVICT_MS / 60_000
        );
        const wallSeconds = SandboxSettings.positiveNumber(
            env,
            "PENPOT_MCP_SANDBOX_WALL_S",
            SandboxSettings.DEFAULT_WALL_MS / 1000
        );
        const maxHostCalls = SandboxSettings.positiveInteger(
            env,
            "PENPOT_MCP_SANDBOX_MAX_HOST_CALLS",
            SandboxSettings.DEFAULT_MAX_HOST_CALLS
        );
        const maxSessions = SandboxSettings.positiveInteger(
            env,
            "PENPOT_MCP_SANDBOX_MAX_SESSIONS",
            SandboxSettings.DEFAULT_MAX_SESSIONS
        );
        const maxConcurrentCalls = SandboxSettings.positiveInteger(
            env,
            "PENPOT_MCP_SANDBOX_MAX_CONCURRENT",
            SandboxSettings.DEFAULT_MAX_CONCURRENT_CALLS
        );
        const workers = SandboxSettings.workersEnabled(env);
        const pageMb = SandboxSettings.positiveNumber(
            env,
            SandboxSettings.PAGE_MB_VARIABLE,
            SandboxSettings.DEFAULT_MAX_PAGE_MB
        );
        const hostMs = SandboxSettings.positiveNumber(
            env,
            SandboxSettings.HOST_MS_VARIABLE,
            SandboxSettings.DEFAULT_MAX_HOST_MS
        );
        return new SandboxSettings(
            timeoutSeconds * 1000,
            idleMinutes * 60_000,
            wallSeconds * 1000,
            maxHostCalls,
            maxSessions,
            maxConcurrentCalls,
            SandboxSettings.DEFAULT_SLOT_WAIT_MS,
            workers,
            pageMb * 1024 * 1024,
            hostMs
        );
    }

    /**
     * Reads a true or false flag, falling back to a default when the variable is unset or blank.
     *
     * @param env - environment to read
     * @param name - variable name
     * @param fallback - value used when the variable is unset or blank
     * @throws Error naming the variable when the value is neither true nor false
     */
    private static flag(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
        const raw = env[name]?.trim().toLowerCase();
        if (raw === undefined || raw === "") {
            return fallback;
        }
        if (raw === "true" || raw === "1") {
            return true;
        }
        if (raw === "false" || raw === "0") {
            return false;
        }
        throw new Error(`${name} must be true or false (got "${raw}").`);
    }

    /**
     * Reads a positive number, falling back to a default when the variable is unset or blank.
     *
     * @param env - environment to read
     * @param name - variable name
     * @param fallback - value used when the variable is unset or blank
     * @throws Error naming the variable when the value is not a positive number
     */
    private static positiveNumber(env: Record<string, string | undefined>, name: string, fallback: number): number {
        const raw = env[name]?.trim();
        if (raw === undefined || raw === "") {
            return fallback;
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`${name} must be a positive number (got "${raw}").`);
        }
        return value;
    }

    /**
     * Reads a positive whole number, falling back to a default when the variable is unset or blank.
     *
     * @param env - environment to read
     * @param name - variable name
     * @param fallback - value used when the variable is unset or blank
     * @throws Error naming the variable when the value is not a positive whole number
     */
    private static positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number): number {
        const raw = env[name]?.trim();
        if (raw === undefined || raw === "") {
            return fallback;
        }
        const value = Number(raw);
        if (!Number.isInteger(value) || value <= 0) {
            throw new Error(`${name} must be a positive integer (got "${raw}").`);
        }
        return value;
    }
}
