import type { TokenCatalogue } from "../../sandbox/ApplyTokenValues";

/** One kept catalogue, with the write count of its file when it was kept. */
interface CatalogueEntry {
    /** Catalogue of the file, which reads the tokens at most once. */
    catalogue: TokenCatalogue;
    /** Number of writes to the file that had ended when the entry was kept. */
    writeCount: number;
    /** Clock reading, in milliseconds, when the entry was kept. */
    keptAt: number;
}

/**
 * Keeps token catalogues of files for a short time, and drops one as soon as the file changes.
 *
 * An entry is reused only while the write count of its file is the one it was kept at, and only for the
 * time to live. Writes made by other processes do not change the count, so the time to live bounds how long
 * such a change can stay unseen.
 */
export class TokenCatalogueCache {
    /** Kept entries, keyed by the token digest and the file id. */
    private readonly entries = new Map<string, CatalogueEntry>();

    /**
     * Creates an empty cache.
     *
     * @param ttlMs - how long an entry is kept, in milliseconds
     * @param now - clock in milliseconds, injectable for tests
     */
    public constructor(
        private readonly ttlMs: number,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * Returns the catalogue of a file for a write count, reusing a kept one when it still fits.
     *
     * @param key - the token digest and the file id, joined by a colon
     * @param writeCount - writes to the file that have ended, as the caller sees them now
     * @param create - makes a new catalogue, which reads nothing until it is asked for a token
     */
    public get(key: string, writeCount: number, create: () => TokenCatalogue): TokenCatalogue {
        const current = this.now();
        this.prune(current);
        const entry = this.entries.get(key);
        if (entry !== undefined && entry.writeCount === writeCount) {
            return entry.catalogue;
        }
        const catalogue = create();
        this.entries.set(key, { catalogue, writeCount, keptAt: current });
        return catalogue;
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
