/** A caller that waits for a turn at the gate. */
interface Waiter {
    /** Hands the caller its turn, and stops its wait timer. */
    grant: () => void;
}

/**
 * Lets a few imports run at once, queues a few more, and refuses the rest with a "busy, retry later" error.
 *
 * A waiting caller gives up after the wait time, so that a queue cannot hold the memory of its callers for long.
 * One gate serves the whole process, so the limits hold across all sessions.
 */
export class ImportGate {
    /** Number of imports that run now. */
    private active = 0;

    /** Callers that wait for a turn, in order. */
    private readonly waiting: Waiter[] = [];

    /**
     * Creates a gate.
     *
     * @param permits - imports that may run at once
     * @param maxWaiting - callers that may wait; a caller above this is refused at once
     * @param waitMs - longest time a caller waits for a turn, in milliseconds
     */
    public constructor(
        private readonly permits: number,
        private readonly maxWaiting: number,
        private readonly waitMs: number
    ) {}

    /**
     * Runs a task once it has a turn, and gives the turn back when the task ends.
     *
     * @param task - the import to run
     * @returns the value that the task resolves to
     * @throws Error with the text "busy, retry later" when the queue is full or the wait is too long
     */
    public async withPermit<T>(task: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    /** Returns the number of callers that wait for a turn. */
    public get waitingCount(): number {
        return this.waiting.length;
    }

    /**
     * Takes a turn, or waits for one.
     *
     * @throws Error when the queue is full, or the wait passes the time limit
     */
    private acquire(): Promise<void> {
        if (this.active < this.permits) {
            this.active += 1;
            return Promise.resolve();
        }
        if (this.waiting.length >= this.maxWaiting) {
            return Promise.reject(ImportGate.busy("too many archive imports are already waiting"));
        }
        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
                grant: () => {
                    clearTimeout(timer);
                    resolve();
                },
            };
            const timer = setTimeout(() => {
                const index = this.waiting.indexOf(waiter);
                if (index >= 0) {
                    this.waiting.splice(index, 1);
                }
                reject(ImportGate.busy(`the import waited ${this.waitMs / 1000} seconds for a turn`));
            }, this.waitMs);
            this.waiting.push(waiter);
        });
    }

    /** Passes the turn to the next waiting caller, or frees it when nobody waits. */
    private release(): void {
        const next = this.waiting.shift();
        if (next !== undefined) {
            next.grant();
        } else {
            this.active -= 1;
        }
    }

    /**
     * Builds the error of a refused or timed-out import.
     *
     * @param reason - why the import was refused, in words
     */
    private static busy(reason: string): Error {
        return new Error(`busy, retry later: ${reason}. Retry in a few minutes.`);
    }
}
