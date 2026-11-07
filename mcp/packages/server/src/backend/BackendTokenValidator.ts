import type { PenpotBackend } from "../PenpotBackendClient";
import { createLogger } from "../logger";
import { BackendRpcError } from "./BackendRpcError";
import { CallContext } from "./CallContext";
import { TokenDigest } from "./TokenDigest";

/**
 * The version of the adapter and backend contract that this adapter speaks. The backend reports the version
 * it serves in `mcp-whoami`; the adapter refuses to run backend tools against an older backend.
 */
export const SUPPORTED_CONTRACT_VERSION = 1;

/** Identity, scopes and capabilities of an MCP token, as reported by the backend `mcp-whoami` command. */
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
    /**
     * Version of the adapter and backend contract that the backend speaks. Absent on a backend that predates
     * the field.
     */
    contractVersion?: number;
    /** Names of the operations that the backend accepts, so a tool can hide the ones it lacks. */
    operations?: string[];
    /** Limits that the backend applies, as the backend names them. */
    limits?: Record<string, number>;
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

/** Error raised when the backend is older than this adapter supports for backend mode. */
export class BackendTooOldError extends Error {
    /**
     * Creates the error.
     *
     * @param message - the explanation, which names the versions
     */
    constructor(message: string) {
        super(message);
        this.name = "BackendTooOldError";
    }
}

/** A cached validation result and the instant it stops being trusted. */
interface CacheEntry {
    promise: Promise<WhoAmI>;
    expiresAt: number;
}

/**
 * Checks MCP tokens against the backend and caches the answers.
 *
 * The cache is keyed by the SHA-256 digest of the token, so the raw token is never stored. A successful answer
 * is kept for 60 seconds. A rejection is kept for 5 seconds, so a flood of random tokens does not become a
 * flood of backend calls.
 */
export class BackendTokenValidator {
    /** Time a successful validation is trusted, in milliseconds. */
    public static readonly CACHE_TTL_MS = 60_000;
    /** Time a rejection is trusted, in milliseconds. */
    public static readonly REJECTION_TTL_MS = 5_000;
    /** Smallest time between two sweeps of the expired entries, in milliseconds. */
    public static readonly PRUNE_INTERVAL_MS = 1_000;

    private readonly logger = createLogger("BackendTokenValidator");
    private readonly entries = new Map<string, CacheEntry>();
    /** Digests of rejected tokens, each with the instant the rejection stops being trusted. */
    private readonly rejections = new Map<string, number>();
    private lastPruneAt = Number.NEGATIVE_INFINITY;
    private contractErrorLogged = false;

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
     * Validates a token, reusing a successful answer for up to 60 seconds and a rejection for up to 5 seconds.
     *
     * Also binds the token id of the answer to the current tool call, so the log line carries the same
     * fingerprint as the backend. Every call checks that the backend speaks the supported contract.
     *
     * @param token - the MCP user token
     * @returns the identity of the token, with the operations and limits the backend reports
     * @throws TokenRejectedError when the backend answers 401 or 403
     * @throws BackendTooOldError when the backend does not speak the supported contract version
     */
    public async validate(token: string): Promise<WhoAmI> {
        this.pruneExpired();
        const key = TokenDigest.sha256Hex(token);
        const current = this.now();
        const rejectedUntil = this.rejections.get(key);
        if (rejectedUntil !== undefined && rejectedUntil > current) {
            throw new TokenRejectedError();
        }
        const cached = this.entries.get(key);
        const whoami = cached && cached.expiresAt > current ? await cached.promise : await this.fill(key, token);
        const tokenId = whoami.tokenId;
        if (tokenId !== undefined) {
            const call = CallContext.current();
            if (call) {
                call.tokenFp = TokenDigest.tokenIdFingerprint(tokenId);
            }
        }
        this.assertContract(whoami);
        return whoami;
    }

    /**
     * Asks the backend for a token that is not cached, and caches the pending answer.
     *
     * @param key - digest of the token, the cache key
     * @param token - the MCP user token
     */
    private async fill(key: string, token: string): Promise<WhoAmI> {
        const promise = this.fetchWhoAmI(token);
        this.entries.set(key, { promise, expiresAt: this.now() + BackendTokenValidator.CACHE_TTL_MS });
        try {
            return await promise;
        } catch (error) {
            if (this.entries.get(key)?.promise === promise) {
                this.entries.delete(key);
            }
            if (error instanceof TokenRejectedError) {
                this.rejections.set(key, this.now() + BackendTokenValidator.REJECTION_TTL_MS);
            }
            throw error;
        }
    }

    /**
     * Calls `mcp-whoami` and maps an authentication failure to a token-rejected error.
     *
     * The call runs without the signal of the tool call. The answer is shared by every call that uses the
     * token, so one client that disconnects must not fail the others.
     */
    private async fetchWhoAmI(token: string): Promise<WhoAmI> {
        try {
            return await CallContext.withoutSignal(() => this.backend.callCommand<WhoAmI>(token, "mcp-whoami", {}));
        } catch (error) {
            if (error instanceof BackendRpcError && (error.status === 401 || error.status === 403)) {
                throw new TokenRejectedError();
            }
            throw error;
        }
    }

    /**
     * Checks the contract version of the backend. An absent or older version is refused, and the adapter
     * logs the reason once.
     *
     * @param whoami - the answer of `mcp-whoami`
     * @throws BackendTooOldError when the backend is older than {@link SUPPORTED_CONTRACT_VERSION}
     */
    private assertContract(whoami: WhoAmI): void {
        const version = whoami.contractVersion;
        if (typeof version === "number" && version >= SUPPORTED_CONTRACT_VERSION) {
            return;
        }
        const message =
            `backend too old for backend mode: it reports contract version ${version ?? "none"}, ` +
            `this adapter needs ${SUPPORTED_CONTRACT_VERSION} or later. Upgrade the Penpot backend.`;
        if (!this.contractErrorLogged) {
            this.contractErrorLogged = true;
            this.logger.error(message);
        }
        throw new BackendTooOldError(message);
    }

    /**
     * Drops entries whose trust period ended. The sweep runs at most once per second, so a busy server does not
     * walk the whole map on every call.
     */
    private pruneExpired(): void {
        const current = this.now();
        if (current - this.lastPruneAt < BackendTokenValidator.PRUNE_INTERVAL_MS) {
            return;
        }
        this.lastPruneAt = current;
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= current) {
                this.entries.delete(key);
            }
        }
        for (const [key, until] of this.rejections) {
            if (until <= current) {
                this.rejections.delete(key);
            }
        }
    }
}
