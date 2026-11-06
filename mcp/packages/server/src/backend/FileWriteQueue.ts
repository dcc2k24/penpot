/**
 * Serialises write calls per MCP token and file.
 *
 * Calls for the same `(token, file)` run one after another in submission order, so parallel tool calls
 * never reach the backend's per-profile update queue at once. A failed call does not block the next one.
 */
export class FileWriteQueue {
    /** Settled tail of the queue of each `(token, file)` pair. */
    private readonly tails = new Map<string, Promise<void>>();

    /**
     * Number of `(token, file)` pairs that still have writes queued or running.
     *
     * An entry is removed once its last write settles, whether the write succeeded or failed.
     */
    public get pendingFileCount(): number {
        return this.tails.size;
    }

    /**
     * Runs a write task after the writes already queued for the same token and file.
     *
     * @param tokenDigest - digest of the MCP token, never the raw token
     * @param fileId - file the write targets
     * @param task - the write to run
     * @returns the result, or the error, of the task
     */
    public run<T>(tokenDigest: string, fileId: string, task: () => Promise<T>): Promise<T> {
        const key = `${tokenDigest}:${fileId}`;
        const previous = this.tails.get(key) ?? Promise.resolve();
        const result = previous.then(task);
        const tail = result.then(
            () => undefined,
            () => undefined
        );
        this.tails.set(key, tail);
        void tail.then(() => {
            if (this.tails.get(key) === tail) {
                this.tails.delete(key);
            }
        });
        return result;
    }
}
