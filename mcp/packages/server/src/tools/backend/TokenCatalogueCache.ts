import { TokenDigest } from "../../backend/TokenDigest";
import type { TokenResolver } from "../../sandbox/TokenResolver";

/** One kept resolver, with the write count of its file when it was read. */
interface ResolverEntry {
    /** The token set of the file, as read; it holds no MCP token. */
    resolver: TokenResolver;
    /** Number of writes to the file that had ended when the token set was read. */
    writeCount: number;
    /** Clock reading, in milliseconds, when the token set was read. */
    keptAt: number;
}

/**
 * Keeps the token sets of files for a short time, and drops one as soon as the file changes.
 *
 * Only the resolved token set is kept, never the MCP token that read it, and the entries are keyed by the token
 * digest and the file id. An entry is reused only while the write count of its file is the one it was read at, and
 * only for the time to live. The table holds at most `capacity` entries; the least recently used one is dropped
 * first. Writes made by other processes do not change the count, so the time to live bounds how long such a change
 * can stay unseen.
 */
export class TokenCatalogueCache {
    /** Most entries kept at once, unless the constructor is given another capacity. */
    public static readonly DEFAULT_CAPACITY = 200;

    /** Kept entries, in order of use: the least recently used first. */
    private readonly entries = new Map<string, ResolverEntry>();

    /**
     * Creates an empty cache.
     *
     * @param ttlMs - how long an entry is kept, in milliseconds
     * @param capacity - the most entries kept at once
     * @param now - clock in milliseconds, injectable for tests
     */
    public constructor(
        private readonly ttlMs: number,
        private readonly capacity: number = TokenCatalogueCache.DEFAULT_CAPACITY,
        private readonly now: () => number = Date.now
    ) {}

    /** Returns the number of entries kept. */
    public get size(): number {
        return this.entries.size;
    }

    /**
     * Returns the cache key of a file for a token: the SHA-256 digest of the token and the file id.
     *
     * The raw token is never part of a key, so a dump of the cache shows no token.
     *
     * @param userToken - the MCP token of the request
     * @param fileId - the file id
     */
    public static keyOf(userToken: string, fileId: string): string {
        return `${TokenDigest.sha256Hex(userToken)}:${fileId}`;
    }

    /**
     * Returns the kept token set of a file when it was read at the same write count, and marks it as used.
     *
     * @param key - the key made by {@link keyOf}
     * @param writeCount - writes to the file that have ended, as the caller sees them now
     * @returns the token set, or undefined when none is kept for this write count
     */
    public lookup(key: string, writeCount: number): TokenResolver | undefined {
        this.prune(this.now());
        const entry = this.entries.get(key);
        if (entry === undefined) {
            return undefined;
        }
        if (entry.writeCount !== writeCount) {
            this.entries.delete(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.resolver;
    }

    /**
     * Keeps the token set that a read produced, and drops the least recently used entries above the capacity.
     *
     * @param key - the key made by {@link keyOf}
     * @param writeCount - writes to the file that had ended when the token set was read
     * @param resolver - the token set of the file
     */
    public store(key: string, writeCount: number, resolver: TokenResolver): void {
        const current = this.now();
        this.prune(current);
        this.entries.delete(key);
        this.entries.set(key, { resolver, writeCount, keptAt: current });
        while (this.entries.size > this.capacity) {
            const oldest = this.entries.keys().next();
            if (oldest.done === true) {
                break;
            }
            this.entries.delete(oldest.value);
        }
    }

    /**
     * Drops the entries that are older than the time to live.
     *
     * @param current - the clock reading to compare with
     */
    private prune(current: number): void {
        for (const [key, entry] of this.entries) {
            if (current - entry.keptAt >= this.ttlMs) {
                this.entries.delete(key);
            }
        }
    }
}
