/**
 * Size limit of HTTP request bodies, read from `PENPOT_MCP_MAX_BODY_MB`.
 *
 * The limit for authenticated requests sizes the JSON parser of the HTTP endpoint and the base64 fields of
 * the backend tools that carry file contents inline. A request without a token gets the small
 * {@link BodyLimit.UNAUTHENTICATED_BYTES} limit, so that a stranger cannot make the server buffer large bodies.
 */
export class BodyLimit {
    /** Default request body limit, in megabytes. */
    public static readonly DEFAULT_MEGABYTES = 32;

    /**
     * Body limit of a request that the backend has not validated, in bytes. Plugin-bridge exports and
     * imports carry images inline, so this floor is 4 MB rather than the 2 MB of the JSON parser default.
     */
    public static readonly UNAUTHENTICATED_BYTES = 4 * 1024 * 1024;

    /** Bytes in one megabyte. */
    private static readonly BYTES_PER_MEGABYTE = 1024 * 1024;

    /**
     * Reads the request body limit in megabytes.
     *
     * @param env - environment to read
     * @returns the limit in megabytes, the default when the variable is unset or blank
     * @throws Error naming the variable when the value is not a positive number
     */
    public static megabytesOf(env: Record<string, string | undefined>): number {
        const name = "PENPOT_MCP_MAX_BODY_MB";
        const raw = env[name]?.trim();
        if (raw === undefined || raw === "") {
            return BodyLimit.DEFAULT_MEGABYTES;
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`${name} must be a positive number of megabytes (got "${raw}").`);
        }
        return value;
    }

    /**
     * Reads the request body limit in bytes.
     *
     * @param env - environment to read
     * @throws Error naming the variable when the value is not a positive number
     */
    public static bytesOf(env: Record<string, string | undefined>): number {
        return Math.floor(BodyLimit.megabytesOf(env) * BodyLimit.BYTES_PER_MEGABYTE);
    }
}
