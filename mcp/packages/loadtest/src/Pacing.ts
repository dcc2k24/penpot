/**
 * Warm-up of a run: the first calls, or the calls that finish in the first part of the run, are left out of the
 * statistics. The calls still run and are still checked, so that captured variables stay available.
 */
export type WarmupSpec = { calls: number } | { durationMs: number };

/**
 * Counts the warm-up calls of a run and tells whether a finished call belongs to it.
 */
export class WarmupGate {
    private remainingCalls = 0;
    private untilMs = 0;
    private excluded = 0;

    /**
     * @param spec - warm-up of the run, or undefined for none
     * @param startedAt - performance.now() value at which the run started
     */
    constructor(spec: WarmupSpec | undefined, startedAt: number) {
        if (spec === undefined) {
            return;
        }
        if ("calls" in spec) {
            this.remainingCalls = spec.calls;
        } else {
            this.untilMs = startedAt + spec.durationMs;
        }
    }

    /**
     * Decides whether a call that finished at this time is part of the warm-up, and counts it when it is. The
     * first calls of the run count in the order they finish; a duration covers the calls that finish before it ends.
     *
     * @param finishedAt - performance.now() value at which the call finished
     * @returns true when the call must be left out of the statistics
     */
    excludes(finishedAt: number): boolean {
        let warm = false;
        if (this.remainingCalls > 0) {
            this.remainingCalls--;
            warm = true;
        } else if (finishedAt < this.untilMs) {
            warm = true;
        }
        if (warm) {
            this.excluded++;
        }
        return warm;
    }

    /**
     * Number of calls left out so far.
     */
    get excludedCalls(): number {
        return this.excluded;
    }
}

/**
 * Due times of the calls of one agent in open-loop mode. Call k is due at start + k / rate. The due time is the
 * intended send time: a call that starts late still counts its wait from that time.
 */
export class ArrivalSchedule {
    private index = 0;

    /**
     * @param perSecond - calls per second for this agent
     * @param startedAt - performance.now() value at which the first call is due
     */
    constructor(
        private readonly perSecond: number,
        private readonly startedAt: number
    ) {}

    /**
     * Returns the due time of the next call and moves the schedule on by one interval.
     */
    reserve(): number {
        const due = this.startedAt + (this.index * 1000) / this.perSecond;
        this.index++;
        return due;
    }
}

/**
 * Waits until a time on the performance.now() clock. Returns at once when that time has passed.
 *
 * @param time - performance.now() value to wait for
 */
export async function waitUntil(time: number): Promise<void> {
    const wait = time - performance.now();
    if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
    }
}

/**
 * Text of a warm-up setting for the result and the report, for example "200 calls" or "30 s".
 *
 * @param spec - warm-up of the run
 */
export function describeWarmup(spec: WarmupSpec): string {
    return "calls" in spec ? `${spec.calls} calls` : `${spec.durationMs / 1000} s`;
}

/**
 * Reads the --warmup option. A whole number is a count of calls. A number with a unit (s, m or h) is a time.
 *
 * @param text - value from the command line
 * @returns the warm-up of the run
 * @throws Error when the value is neither a count of at least 1 nor a positive time with a unit
 */
export function parseWarmup(text: string): WarmupSpec {
    const trimmed = text.trim();
    if (/^\d+$/.test(trimmed)) {
        const calls = Number(trimmed);
        if (calls < 1) {
            throw new Error("--warmup must be at least 1 call, or a time such as 60s");
        }
        return { calls };
    }
    const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(trimmed);
    if (match === null) {
        throw new Error(`--warmup must be a number of calls or a time such as 60s, got "${text}"`);
    }
    const factor: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
    const durationMs = Number(match[1]) * factor[match[2]];
    if (durationMs <= 0) {
        throw new Error(`--warmup must be longer than zero, got "${text}"`);
    }
    return { durationMs };
}
