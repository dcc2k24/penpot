import type { PenpotBackend } from "../PenpotBackendClient";
import { BackendRpcError } from "./BackendRpcError";
import { TokenDigest } from "./TokenDigest";

/** Identity and scopes of an MCP token, as reported by the backend `mcp-whoami` command. */
export interface WhoAmI {
    /** Profile that owns the token. */
    profileId: string;
    /** Scopes granted to the token, for example `mcp:read`. */
    scopes: string[];
    /** Token identifier, when the backend reports one. */
    tokenId?: string;
    /** Expiry instant of the token, or `null` when it does not expire. */
    expiresAt?: string | null;
    /** Backend version. */
    version?: { full: string; base: string };
    /** Features enabled on the backend. */
    features?: string[];
    /** Full name of the profile. */
    fullname?: string;
    /** Email address of the profile. */
    email?: string;
}

/**
 * Error raised when the backend rejects an MCP token with status 401 or 403.
 *
 * The HTTP layer checks for this class to answer 401 with a WWW-Authenticate challenge.
 */
export class TokenRejectedError extends Error {
    /** Creates the error with the standard rejection message. */
    constructor() {
        super("The MCP token was rejected by the backend. Check that it exists and is not expired.");
        this.name = "TokenRejectedError";
    }
}

/** A cached validation result and the instant it stops being trusted. */
interface CacheEntry {
    promise: Promise<WhoAmI>;
    expiresAt: number;
}

/**
 * Checks MCP tokens against the backend and caches successful answers.
 *
 * The cache is keyed by the SHA-256 digest of the token, so the raw token is never stored. A token
 * rejected by the backend is never cached.
 */
export class BackendTokenValidator {
    /** Time a successful validation is trusted, in milliseconds. */
    public static readonly CACHE_TTL_MS = 60_000;

    private readonly entries = new Map<string, CacheEntry>();

    /**
     * Creates a validator.
     *
     * @param backend - backend used to call `mcp-whoami`
     * @param now - clock in milliseconds, injectable for tests
     */
    constructor(
        private readonly backend: PenpotBackend,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * Validates a token, reusing a successful answer for up to 60 seconds.
     *
     * @param token - the MCP user token
     * @returns the identity of the token
     * @throws TokenRejectedError when the backend answers 401 or 403
     */
    public async validate(token: string): Promise<WhoAmI> {
        this.pruneExpired();
        const key = TokenDigest.sha256Hex(token);
        const cached = this.entries.get(key);
        if (cached) {
            return cached.promise;
        }
        const promise = this.fetchWhoAmI(token);
        this.entries.set(key, { promise, expiresAt: this.now() + BackendTokenValidator.CACHE_TTL_MS });
        try {
            return await promise;
        } catch (error) {
            if (this.entries.get(key)?.promise === promise) {
                this.entries.delete(key);
            }
            throw error;
        }
    }

    /** Calls `mcp-whoami` and maps an authentication failure to a token-rejected error. */
    private async fetchWhoAmI(token: string): Promise<WhoAmI> {
        try {
            return await this.backend.callCommand<WhoAmI>(token, "mcp-whoami", {});
        } catch (error) {
            if (error instanceof BackendRpcError && (error.status === 401 || error.status === 403)) {
                throw new TokenRejectedError();
            }
            throw error;
        }
    }

    /** Drops entries whose trust period ended, so the cache does not grow without bound. */
    private pruneExpired(): void {
        const current = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= current) {
                this.entries.delete(key);
            }
        }
    }
}
