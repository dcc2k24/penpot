import { CallContext } from "./CallContext";

/**
 * Serialises write calls per MCP token and file.
 *
 * Calls for the same `(token, file)` run one after another in submission order, so parallel tool calls
 * never reach the backend's per-profile update queue at once. A failed call does not block the next one.
 *
 * A write that is still waiting when its signal fires is skipped and rejects with an `AbortError`. A write
 * that has started always runs to its end: the backend may already have applied it, and the caller must
 * check the file state instead.
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
     * The task runs without the signal of its call. A started write therefore never sees an abort.
     *
     * @param tokenDigest - digest of the MCP token, never the raw token
     * @param fileId - file the write targets
     * @param task - the write to run
     * @param signal - fires when the call is abandoned; defaults to the signal of the current tool call
     * @returns the result, or the error, of the task; an `AbortError` when the signal fired before the start
     */
    public run<T>(
        tokenDigest: string,
        fileId: string,
        task: () => Promise<T>,
        signal: AbortSignal | undefined = CallContext.current()?.signal
    ): Promise<T> {
        const key = `${tokenDigest}:${fileId}`;
        const previous = this.tails.get(key) ?? Promise.resolve();
        const result = previous.then(() => {
            if (signal?.aborted) {
                throw new DOMException("The write was abandoned before it started.", "AbortError");
            }
            return CallContext.withoutSignal(task);
        });
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
