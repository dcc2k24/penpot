/**
 * Size limit of HTTP request bodies, read from `PENPOT_MCP_MAX_BODY_MB`.
 *
 * The same limit sizes the JSON parser of the HTTP endpoint and the base64 fields of the backend tools that
 * carry file contents inline, so that a tool never accepts an argument the endpoint would refuse.
 */
export class BodyLimit {
    /** Default request body limit, in megabytes. */
    public static readonly DEFAULT_MEGABYTES = 32;

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
