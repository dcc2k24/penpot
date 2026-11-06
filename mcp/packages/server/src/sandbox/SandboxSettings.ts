/** Tunables of the sandbox runtime behind `execute_code`, read from the environment. */
export class SandboxSettings {
    /** Default guest CPU time of one call, in milliseconds. */
    public static readonly DEFAULT_CPU_BUDGET_MS = 10_000;
    /** Default idle time after which a session sandbox is evicted, in milliseconds. */
    public static readonly DEFAULT_IDLE_EVICT_MS = 30 * 60 * 1000;
    /** Default wall-clock limit of one call, in milliseconds. */
    public static readonly DEFAULT_WALL_MS = 120_000;
    /** Default most host primitive calls one script may make. */
    public static readonly DEFAULT_MAX_HOST_CALLS = 1000;
    /** Default most live sandbox runtimes. */
    public static readonly DEFAULT_MAX_SESSIONS = 50;
    /** Default most calls that run at once. */
    public static readonly DEFAULT_MAX_CONCURRENT_CALLS = 4;
    /** Default time a queued call waits for a free slot, in milliseconds. */
    public static readonly DEFAULT_SLOT_WAIT_MS = 60_000;

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
     */
    constructor(
        public readonly cpuBudgetMs: number = SandboxSettings.DEFAULT_CPU_BUDGET_MS,
        public readonly idleEvictMs: number = SandboxSettings.DEFAULT_IDLE_EVICT_MS,
        public readonly wallMs: number = SandboxSettings.DEFAULT_WALL_MS,
        public readonly maxHostCalls: number = SandboxSettings.DEFAULT_MAX_HOST_CALLS,
        public readonly maxSessions: number = SandboxSettings.DEFAULT_MAX_SESSIONS,
        public readonly maxConcurrentCalls: number = SandboxSettings.DEFAULT_MAX_CONCURRENT_CALLS,
        public readonly slotWaitMs: number = SandboxSettings.DEFAULT_SLOT_WAIT_MS
    ) {}

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
        return new SandboxSettings(
            timeoutSeconds * 1000,
            idleMinutes * 60_000,
            wallSeconds * 1000,
            maxHostCalls,
            maxSessions,
            maxConcurrentCalls
        );
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
