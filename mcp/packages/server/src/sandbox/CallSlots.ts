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
     * @param maxQueued - most calls that may wait in the queue; a call past it is refused at once
     */
    constructor(
        private readonly maxConcurrent: number,
        private readonly waitMs: number,
        private readonly maxQueued: number = Number.POSITIVE_INFINITY
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
     * @throws Error when the queue is full, or when no slot frees up within the wait limit
     */
    public acquire(): Promise<() => void> {
        if (this.held < this.maxConcurrent) {
            this.held += 1;
            return Promise.resolve(this.createRelease());
        }
        if (this.waiters.length >= this.maxQueued) {
            return Promise.reject(
                new Error(
                    `execute_code is busy: ${this.maxConcurrent} running and ${this.maxQueued} queued; retry in a moment.`
                )
            );
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

/**
 * Holds the global slot of one `execute_code` call, and can give it back while the call waits.
 *
 * A call that waits for a rate-limit token must not keep a slot: the wait can be long, and the slot is what the
 * other tokens need. `yieldForWait` frees the slot and returns the function that takes one again.
 */
export class SlotHolder {
    private release: (() => void) | undefined = undefined;
    /** Number of rate-limit waits that gave the slot back and have not resumed yet. */
    private waiting = 0;
    /** Take in progress, so that concurrent takes queue once and never overwrite a held release. */
    private pendingTake: Promise<void> | undefined = undefined;

    /**
     * Creates a holder that takes its slots from the given limiter.
     *
     * @param slots - the global slot limiter
     */
    constructor(private readonly slots: CallSlots) {}

    /**
     * Takes a slot, waiting in the queue when every slot is held. Does nothing when the holder has a slot.
     *
     * @throws Error when no slot frees up within the wait limit
     */
    public take(): Promise<void> {
        if (this.release !== undefined) {
            return Promise.resolve();
        }
        this.pendingTake ??= this.acquireSlot();
        return this.pendingTake;
    }

    /** Gives the slot back, if this holder has one. Calling it again does nothing. */
    public free(): void {
        this.release?.();
        this.release = undefined;
    }

    /**
     * Gives the slot back while the caller waits. Several waits may overlap, since the worker serves host calls
     * at once: the slot is freed by the first of them only, and taken again when the last one resumes.
     *
     * @returns the function that resumes this wait; the caller calls it once when the wait is over
     */
    public yieldForWait(): () => Promise<void> {
        this.waiting += 1;
        if (this.waiting === 1) {
            this.free();
        }
        let resumed = false;
        return async () => {
            if (resumed) {
                return;
            }
            resumed = true;
            this.waiting -= 1;
            if (this.waiting === 0) {
                await this.take();
            }
        };
    }

    /** Waits for a slot and keeps it until {@link free}. */
    private async acquireSlot(): Promise<void> {
        try {
            this.release = await this.slots.acquire();
        } finally {
            this.pendingTake = undefined;
        }
    }
}
