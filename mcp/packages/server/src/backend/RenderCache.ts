import type { RenderedFile } from "./ExporterClient";

/** How long a render stays in the cache, in milliseconds, when the cache is not given another period. */
export const RENDER_CACHE_TTL_MS = 15 * 60_000;

/** One cached render, with the time it was stored. */
interface CacheEntry {
    /** The bytes and media type of the render. */
    file: RenderedFile;
    /** Time the render was stored, in milliseconds on the clock of the cache. */
    storedAt: number;
}

/**
 * In-memory cache of rendered shapes, bounded by the total of their bytes and by an age limit.
 *
 * A render is keyed by file, file revision, page, shape, format, scale and renderer, so a change to the file makes
 * the old render a miss. The least recently used entries are dropped first. An entry older than the age limit is a
 * miss and is dropped. An entry larger than the whole budget is not kept. A budget of zero turns the cache off:
 * nothing is stored and every lookup misses.
 *
 * The cache holds the bytes it is given; callers must not change them after they put them in.
 */
export class RenderCache {
    /** Entries in order of use, oldest first: a Map keeps insertion order, and a use re-inserts the entry. */
    private readonly entries = new Map<string, CacheEntry>();
    /** Total bytes of the entries kept. */
    private totalBytes = 0;

    /**
     * Creates an empty cache.
     *
     * @param budgetBytes - the most bytes the cache holds at once; zero turns the cache off
     * @param ttlMs - how long a render is kept, in milliseconds
     * @param now - the clock, in milliseconds; injectable for tests
     */
    constructor(
        private readonly budgetBytes: number,
        private readonly ttlMs: number = RENDER_CACHE_TTL_MS,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * Builds the key of one render.
     *
     * @param parts - the file id, the file revision, the page id, the shape id, the format, the scale and the renderer
     * @returns the key, with the parts joined by `|`
     */
    public static keyOf(parts: {
        fileId: string;
        revn: number;
        pageId: string;
        shapeId: string;
        format: string;
        scale: number;
        renderer: string;
    }): string {
        return [parts.fileId, parts.revn, parts.pageId, parts.shapeId, parts.format, parts.scale, parts.renderer].join(
            "|"
        );
    }

    /** True when the cache keeps anything at all. */
    public get enabled(): boolean {
        return this.budgetBytes > 0;
    }

    /** The most bytes the cache holds at once. */
    public get capacity(): number {
        return this.budgetBytes;
    }

    /** Total bytes of the entries kept now. */
    public get bytes(): number {
        return this.totalBytes;
    }

    /**
     * Returns the render kept under a key, and makes it the most recently used entry. An entry past its age limit is
     * dropped and reported as a miss.
     *
     * @param key - the key built by {@link keyOf}
     * @returns the render, or undefined when the key is not kept or is too old
     */
    public get(key: string): RenderedFile | undefined {
        const found = this.entries.get(key);
        if (found === undefined) {
            return undefined;
        }
        if (this.now() - found.storedAt >= this.ttlMs) {
            this.delete(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, found);
        return found.file;
    }

    /**
     * Keeps a render under a key, dropping the least recently used renders until the total fits the budget.
     *
     * A render larger than the whole budget is not kept, and a key that was kept before is replaced.
     *
     * @param key - the key built by {@link keyOf}
     * @param file - the bytes and media type of the render
     */
    public put(key: string, file: RenderedFile): void {
        if (!this.enabled) {
            return;
        }
        this.delete(key);
        const size = file.bytes.byteLength;
        if (size > this.budgetBytes) {
            return;
        }
        this.entries.set(key, { file, storedAt: this.now() });
        this.totalBytes += size;
        for (const [oldest, dropped] of this.entries) {
            if (this.totalBytes <= this.budgetBytes) {
                break;
            }
            this.entries.delete(oldest);
            this.totalBytes -= dropped.file.bytes.byteLength;
        }
    }

    /**
     * Drops the render kept under a key, when there is one.
     *
     * @param key - the key built by {@link keyOf}
     */
    public delete(key: string): void {
        const existing = this.entries.get(key);
        if (existing !== undefined) {
            this.entries.delete(key);
            this.totalBytes -= existing.file.bytes.byteLength;
        }
    }
}
