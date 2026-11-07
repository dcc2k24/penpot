/**
 * Counts the writes that ended per file, with a bounded number of files kept in memory.
 *
 * A reader that caches something of a file compares its count to tell whether the file changed since. When the
 * table is full, the file that was written longest ago is dropped. Its count then reads as the eviction floor,
 * which is above every count the dropped file ever had. So a cache entry from before the eviction never matches
 * again, and the only cost of an eviction is a cache miss.
 */
export class WriteCounter {
    /** Count of the last write per file, in the order of their last write, oldest first. */
    private readonly counts = new Map<string, number>();

    /** Number of writes recorded so far, across all files. */
    private sequence = 0;

    /** Count that an unknown file reads as. It rises above every count that an evicted file had. */
    private floor = 0;

    /**
     * Creates an empty counter.
     *
     * @param limit - the most files kept at once; a file beyond it evicts the one written longest ago
     */
    public constructor(private readonly limit: number) {}

    /**
     * Returns the count of a file: the sequence number of its last write, or the eviction floor when it is unknown.
     *
     * @param key - the file key
     */
    public countOf(key: string): number {
        return this.counts.get(key) ?? this.floor;
    }

    /**
     * Records that a write to a file ended, which moves the file to the newest position.
     *
     * @param key - the file key
     */
    public recordWrite(key: string): void {
        this.sequence += 1;
        this.counts.delete(key);
        this.counts.set(key, this.sequence);
        while (this.counts.size > this.limit) {
            const oldest = this.counts.entries().next();
            if (oldest.done === true) {
                break;
            }
            const [oldestKey, oldestCount] = oldest.value;
            this.counts.delete(oldestKey);
            this.floor = Math.max(this.floor, oldestCount + 1);
        }
    }
}
