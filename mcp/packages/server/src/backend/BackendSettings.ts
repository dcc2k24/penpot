/** Tunables of backend mode, read from the environment. */
export class BackendSettings {
    /** Default timeout of backend commands, in seconds. */
    public static readonly DEFAULT_TIMEOUT_SECONDS = 120;
    /** Default sustained requests per second and MCP token. */
    public static readonly DEFAULT_RATE_LIMIT_PER_SECOND = 10;
    /** Default burst of requests per MCP token. */
    public static readonly DEFAULT_RATE_LIMIT_BURST = 20;
    /** Default base URI of the Penpot exporter service. */
    public static readonly DEFAULT_EXPORTER_URI = "http://localhost:6061/";
    /** Default cap on the body of one backend response, in megabytes. */
    public static readonly DEFAULT_MAX_RESPONSE_MB = 64;

    /**
     * Creates settings from explicit values.
     *
     * @param timeoutSeconds - default timeout of backend commands, in seconds
     * @param rateLimitPerSecond - sustained requests per second and MCP token
     * @param rateLimitBurst - requests per MCP token that may be sent at once
     * @param allowQueryToken - whether the `userToken` query parameter is accepted
     * @param exporterUri - base URI of the Penpot exporter service
     * @param maxResponseMb - cap on the body of one backend response, in megabytes
     * @param assetsUri - base URI of the asset downloads, or undefined to use the origin named by the exporter
     */
    constructor(
        public readonly timeoutSeconds: number = BackendSettings.DEFAULT_TIMEOUT_SECONDS,
        public readonly rateLimitPerSecond: number = BackendSettings.DEFAULT_RATE_LIMIT_PER_SECOND,
        public readonly rateLimitBurst: number = BackendSettings.DEFAULT_RATE_LIMIT_BURST,
        public readonly allowQueryToken: boolean = true,
        public readonly exporterUri: string = BackendSettings.DEFAULT_EXPORTER_URI,
        public readonly maxResponseMb: number = BackendSettings.DEFAULT_MAX_RESPONSE_MB,
        public readonly assetsUri: string | undefined = undefined
    ) {}

    /**
     * Reads the backend settings from environment variables.
     *
     * @param env - environment to read
     * @throws Error naming the variable when a value is malformed
     */
    public static fromEnvironment(env: Record<string, string | undefined>): BackendSettings {
        return new BackendSettings(
            BackendSettings.positiveNumber(
                env,
                "PENPOT_MCP_BACKEND_TIMEOUT_S",
                BackendSettings.DEFAULT_TIMEOUT_SECONDS
            ),
            BackendSettings.positiveNumber(
                env,
                "PENPOT_MCP_RATE_LIMIT_RPS",
                BackendSettings.DEFAULT_RATE_LIMIT_PER_SECOND
            ),
            BackendSettings.positiveNumber(
                env,
                "PENPOT_MCP_RATE_LIMIT_BURST",
                BackendSettings.DEFAULT_RATE_LIMIT_BURST
            ),
            BackendSettings.booleanFlag(env, "PENPOT_MCP_ALLOW_QUERY_TOKEN", true),
            BackendSettings.readExporterUri(env),
            BackendSettings.readMaxResponseMb(env),
            BackendSettings.readAssetsUri(env)
        );
    }

    /**
     * Reads the cap on the body of one backend response, in megabytes.
     *
     * Unlike the other settings this never throws: an unset, blank or non-positive value, or one that is
     * not a number, falls back to {@link BackendSettings.DEFAULT_MAX_RESPONSE_MB}.
     *
     * @param env - environment to read
     * @returns the cap in megabytes, a positive number
     */
    public static readMaxResponseMb(env: Record<string, string | undefined>): number {
        const raw = env["PENPOT_MCP_BACKEND_MAX_RESPONSE_MB"]?.trim();
        const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
            return BackendSettings.DEFAULT_MAX_RESPONSE_MB;
        }
        return value;
    }

    /**
     * Reads a positive number, falling back to a default when the variable is unset or blank.
     *
     * @param env - environment to read
     * @param name - variable name
     * @param fallback - value used when the variable is unset or blank
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
     * Reads a `true` or `false` flag, falling back to a default when the variable is unset or blank.
     *
     * @param env - environment to read
     * @param name - variable name
     * @param fallback - value used when the variable is unset or blank
     */
    private static booleanFlag(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
        const raw = env[name]?.trim().toLowerCase();
        if (raw === undefined || raw === "") {
            return fallback;
        }
        if (raw !== "true" && raw !== "false") {
            throw new Error(`${name} must be "true" or "false" (got "${env[name]}").`);
        }
        return raw === "true";
    }

    /**
     * Reads the base URI of asset downloads, which is optional.
     *
     * @param env - environment to read
     * @returns the normalized absolute URI, or undefined when the variable is unset or blank
     * @throws Error naming the variable when the value is not an HTTP(S) URI without credentials, query or fragment
     */
    public static readAssetsUri(env: Record<string, string | undefined>): string | undefined {
        const name = "PENPOT_MCP_ASSETS_URI";
        const raw = env[name]?.trim();
        if (raw === undefined || raw === "") {
            return undefined;
        }
        return BackendSettings.parseHttpUri(name, raw);
    }

    /**
     * Reads the exporter base URI, falling back to the default when the variable is unset or blank.
     *
     * @param env - environment to read
     * @returns the normalized absolute URI
     * @throws Error naming the variable when the value is not an HTTP(S) URI without credentials, query or fragment
     */
    private static readExporterUri(env: Record<string, string | undefined>): string {
        const name = "PENPOT_MCP_EXPORTER_URI";
        const raw = env[name]?.trim();
        if (raw === undefined || raw === "") {
            return BackendSettings.DEFAULT_EXPORTER_URI;
        }
        return BackendSettings.parseHttpUri(name, raw);
    }

    /**
     * Parses an absolute HTTP(S) URI without credentials, query or fragment.
     *
     * @param name - variable name, named in the error
     * @param raw - the trimmed value of the variable
     * @returns the normalized URI
     * @throws Error naming the variable when the value is not such a URI
     */
    private static parseHttpUri(name: string, raw: string): string {
        const message = `${name} must be an HTTP(S) URI without credentials, query or fragment (got "${raw}").`;
        let uri: URL;
        try {
            uri = new URL(raw);
        } catch {
            throw new Error(message);
        }
        if (!["http:", "https:"].includes(uri.protocol) || uri.username || uri.password || uri.search || uri.hash) {
            throw new Error(message);
        }
        return uri.href;
    }
}
