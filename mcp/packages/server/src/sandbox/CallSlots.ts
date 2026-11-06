/** Call that waits in the queue for a free slot. */
interface Waiter {
    /** Gives the waiting call a slot, through the release function it receives. */
    readonly resolve: (release: () => void) => void;
    /** Timer that rejects the call when its wait runs out, cleared once the call is granted. */
    timer: ReturnType<typeof setTimeout> | undefined;
}

/** Limits how many `execute_code` calls run at once, and queues the others in first-in, first-out order. */
export class CallSlots {
    private readonly waiters: Waiter[] = [];
    private held = 0;

    /**
     * Creates a slot limiter.
     *
     * @param maxConcurrent - most calls that may hold a slot at once
     * @param waitMs - longest time a queued call waits for a slot, in milliseconds
     */
    constructor(
        private readonly maxConcurrent: number,
        private readonly waitMs: number
    ) {}

    /** Number of slots held by running calls. */
    public get running(): number {
        return this.held;
    }

    /** Number of calls waiting for a slot. */
    public get queued(): number {
        return this.waiters.length;
    }

    /**
     * Takes a slot, waiting in the queue when every slot is held.
     *
     * @returns a promise of the release function, which the caller must call once the call ends
     * @throws Error when no slot frees up within the wait limit
     */
    public acquire(): Promise<() => void> {
        if (this.held < this.maxConcurrent) {
            this.held += 1;
            return Promise.resolve(this.createRelease());
        }
        return new Promise<() => void>((resolve, reject) => {
            const waiter: Waiter = { resolve, timer: undefined };
            waiter.timer = setTimeout(() => {
                const index = this.waiters.indexOf(waiter);
                if (index !== -1) {
                    this.waiters.splice(index, 1);
                }
                reject(
                    new Error(
                        `execute_code is busy: ${this.maxConcurrent} calls are already running; retry in a moment.`
                    )
                );
            }, this.waitMs);
            this.waiters.push(waiter);
        });
    }

    /**
     * Creates a release function that frees its slot once, however often it is called.
     *
     * @returns the release function
     */
    private createRelease(): () => void {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.releaseSlot();
        };
    }

    /** Hands the freed slot to the next waiter, or marks the slot free when nobody waits. */
    private releaseSlot(): void {
        const next = this.waiters.shift();
        if (next === undefined) {
            this.held -= 1;
            return;
        }
        clearTimeout(next.timer);
        next.resolve(this.createRelease());
    }
}
