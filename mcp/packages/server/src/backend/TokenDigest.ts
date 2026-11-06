import { createHash } from "node:crypto";

/**
 * Derives non-reversible identifiers from MCP user tokens, so that caches, buckets and logs never
 * hold a usable credential.
 */
export class TokenDigest {
    /** Number of hex characters kept in a log fingerprint. */
    private static readonly FINGERPRINT_LENGTH = 12;

    /**
     * Returns the SHA-256 digest of a token as lowercase hex.
     *
     * @param token - the MCP user token
     */
    public static sha256Hex(token: string): string {
        return createHash("sha256").update(token, "utf8").digest("hex");
    }

    /**
     * Returns a short fingerprint of a token, suitable for correlating log lines.
     *
     * @param token - the MCP user token
     */
    public static fingerprint(token: string): string {
        return TokenDigest.sha256Hex(token).slice(0, TokenDigest.FINGERPRINT_LENGTH);
    }

    /**
     * Returns the fingerprint of a token, or `<none>` when no token is given.
     *
     * @param token - the MCP user token, or `undefined` when the request carries none
     */
    public static fingerprintOrNone(token: string | undefined): string {
        return token ? TokenDigest.fingerprint(token) : "<none>";
    }
}
