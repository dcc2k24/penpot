/** Error of a caller that waited for a permit until its wait budget ran out. */
export class BusyError extends Error {
    /**
     * Creates the error. The message starts with the name, so `String(error)` reads `Error: <name> is busy`.
     *
     * @param name - the word that starts the text, such as `export`
     * @param waitMs - the wait budget that ran out, in milliseconds
     */
    public constructor(name: string, waitMs: number) {
        super(`${name} is busy, retry later: no slot was free for ${waitMs / 1000} seconds.`);
    }
}

/** A caller that waits for a permit, with the way to grant it a turn. */
interface PermitWaiter {
    /** Hands the caller its permit, and stops its wait timer. */
    grant: () => void;
}

/** How long a caller may wait for a permit, and the signal that ends the wait early. */
export interface PermitWait {
    /** Longest time to wait for a permit, in milliseconds. */
    waitMs: number;
    /** Fires when the caller gives up; a caller that is still waiting then leaves the queue. */
    signal?: AbortSignal;
}

/**
 * Hands out a fixed number of permits to callers in arrival order.
 *
 * A caller that waits too long is refused with a busy error and leaves the queue. A caller that gives up
 * (its signal fires) also leaves the queue. So a caller that is no longer there never takes a permit later.
 */
export class PermitGate {
    /** Permits not held by any caller. */
    private available: number;

    /** Callers that wait for a permit, in arrival order. */
    private readonly waiting: PermitWaiter[] = [];

    /**
     * Creates a gate.
     *
     * @param name - the word that starts the busy error, such as `export`
     * @param permits - permits that may be held at once; at least 1
     */
    public constructor(
        private readonly name: string,
        permits: number
    ) {
        if (permits < 1) {
            throw new Error(`A permit gate needs at least 1 permit; got ${permits}.`);
        }
        this.available = permits;
    }

    /** Returns the number of callers that wait for a permit. */
    public get waitingCount(): number {
        return this.waiting.length;
    }

    /**
     * Takes a permit, waiting for one if none is free, and gives it back when the task ends.
     *
     * @param task - the work to run while the permit is held
     * @param wait - how long to wait, and the signal that ends the wait
     * @returns the value that the task resolves to
     * @throws Error with the busy text when no permit is granted in time, or the signal's reason when it fires first
     */
    public async withPermit<T>(task: () => Promise<T>, wait: PermitWait): Promise<T> {
        await this.acquire(wait);
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    /**
     * Takes a permit, waiting for one if none is free.
     *
     * The caller must call {@link release} once it is done with the permit.
     *
     * @param wait - how long to wait, and the signal that ends the wait
     * @throws Error with the busy text when no permit is granted in time, or the signal's reason when it fires first
     */
    public acquire(wait: PermitWait): Promise<void> {
        if (wait.signal?.aborted === true) {
            return Promise.reject(wait.signal.reason);
        }
        if (this.available > 0) {
            this.available -= 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const leave = (): void => {
                const index = this.waiting.indexOf(waiter);
                if (index >= 0) {
                    this.waiting.splice(index, 1);
                }
            };
            const stop = (): void => {
                clearTimeout(timer);
                wait.signal?.removeEventListener("abort", onAbort);
            };
            const onAbort = (): void => {
                stop();
                leave();
                reject(wait.signal?.reason);
            };
            const waiter: PermitWaiter = {
                grant: () => {
                    stop();
                    resolve();
                },
            };
            const timer = setTimeout(() => {
                stop();
                leave();
                reject(new BusyError(this.name, wait.waitMs));
            }, wait.waitMs);
            wait.signal?.addEventListener("abort", onAbort, { once: true });
            this.waiting.push(waiter);
        });
    }

    /** Gives a permit back: it goes to the first waiting caller, or becomes free when nobody waits. */
    public release(): void {
        const next = this.waiting.shift();
        if (next !== undefined) {
            next.grant();
        } else {
            this.available += 1;
        }
    }
}
