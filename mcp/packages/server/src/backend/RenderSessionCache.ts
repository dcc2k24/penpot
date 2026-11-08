import type { PenpotBackend } from "../PenpotBackendClient";
import { TokenDigest } from "./TokenDigest";

/** A render session token and the instant it expires, in milliseconds since the epoch. */
interface RenderSession {
    token: string;
    expiresAt: number;
}

/** A cached render session, or a mint still in flight. */
interface CacheEntry {
    /** Resolves to the session once the backend has answered. */
    promise: Promise<RenderSession>;
    /** Expiry instant of the session; infinite while the mint is in flight, so that callers share it. */
    expiresAt: number;
}

/** Answer of the backend `create-mcp-render-session` command. */
interface RenderSessionAnswer {
    token: string;
    expiresAt: string;
}

/**
 * Caches render session tokens, which the exporter uses to render shapes of a file.
 *
 * Sessions are keyed by the SHA-256 digest of the MCP user token and the file identifier, so the raw
 * token is never stored. A session is reused until shortly before it expires, and concurrent requests
 * for the same key share one backend call. A failed mint is not cached.
 */
export class RenderSessionCache {
    /** Time before expiry after which a session is no longer reused, in milliseconds. */
    public static readonly REFRESH_MARGIN_MS = 60_000;
    /** Largest number of render sessions kept; the oldest make room for a new one. */
    public static readonly MAX_ENTRIES = 1_000;

    private readonly entries = new Map<string, CacheEntry>();

    /**
     * Creates a cache.
     *
     * @param backend - backend used to call `create-mcp-render-session`
     * @param now - clock in milliseconds, injectable for tests
     */
    constructor(
        private readonly backend: PenpotBackend,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * Returns a render session token for a file, minting one when no reusable session is cached.
     *
     * @param userToken - the MCP user token
     * @param fileId - identifier of the file that the token renders
     * @returns the render session token
     * @throws Error with a "no usable render session" message when the backend answer is malformed
     */
    public async tokenFor(userToken: string, fileId: string): Promise<string> {
        this.pruneUnusable();
        const key = RenderSessionCache.keyOf(userToken, fileId);
        const cached = this.entries.get(key);
        if (cached) {
            return (await cached.promise).token;
        }
        const promise = this.mint(userToken, fileId);
        while (this.entries.size >= RenderSessionCache.MAX_ENTRIES) {
            const oldest = this.entries.keys().next();
            if (oldest.done === true) {
                break;
            }
            this.entries.delete(oldest.value);
        }
        const entry: CacheEntry = { promise, expiresAt: Number.POSITIVE_INFINITY };
        this.entries.set(key, entry);
        try {
            const session = await promise;
            entry.expiresAt = session.expiresAt;
            return session.token;
        } catch (error) {
            // a failed mint must not stay cached, unless a newer entry has replaced it
            if (this.entries.get(key) === entry) {
                this.entries.delete(key);
            }
            throw error;
        }
    }

    /**
     * Drops the cached session of a user token and file, so that the next request mints a new one.
     *
     * @param userToken - the MCP user token
     * @param fileId - identifier of the file that the token renders
     */
    public invalidate(userToken: string, fileId: string): void {
        this.entries.delete(RenderSessionCache.keyOf(userToken, fileId));
    }

    /**
     * Calls the backend for a new render session and checks the answer.
     *
     * @param userToken - the MCP user token
     * @param fileId - identifier of the file that the token renders
     * @returns the token and its expiry instant
     * @throws Error when the answer has no string token or an expiry that does not parse
     */
    private async mint(userToken: string, fileId: string): Promise<RenderSession> {
        const answer = await this.backend.callCommand<Partial<RenderSessionAnswer> | undefined>(
            userToken,
            "create-mcp-render-session",
            { fileId }
        );
        const expiresAt = typeof answer?.expiresAt === "string" ? Date.parse(answer.expiresAt) : Number.NaN;
        if (typeof answer?.token !== "string" || Number.isNaN(expiresAt)) {
            throw new Error("The backend returned no usable render session.");
        }
        return { token: answer.token, expiresAt };
    }

    /**
     * Builds the cache key of a user token and file, from the token digest so that no raw token is kept.
     *
     * @param userToken - the MCP user token
     * @param fileId - identifier of the file that the token renders
     */
    private static keyOf(userToken: string, fileId: string): string {
        return JSON.stringify([TokenDigest.sha256Hex(userToken), fileId]);
    }

    /** Drops entries that may no longer be reused, so the cache does not grow without bound. */
    private pruneUnusable(): void {
        const current = this.now();
        for (const [key, entry] of this.entries) {
            if (current >= entry.expiresAt - RenderSessionCache.REFRESH_MARGIN_MS) {
                this.entries.delete(key);
            }
        }
    }
    /** Number of render sessions held, for the metrics and the tests. */
    public get size(): number {
        return this.entries.size;
    }
}
