import { TokenDigest } from "./TokenDigest";

/** Token bucket of one MCP token. */
interface Bucket {
    /** Tokens left, possibly fractional. */
    available: number;
    /** Instant of the last refill, in milliseconds. */
    updatedAt: number;
}

/**
 * Limits the request rate of each MCP token with a token bucket.
 *
 * Every token owns a bucket that holds up to `burst` requests and refills at `ratePerSecond`. A request
 * without a token left is refused with the time to wait before the next one.
 */
export class TokenRateLimiter {
    /** Number of acquire calls between two sweeps of the bucket table. */
    private static readonly SWEEP_INTERVAL = 256;

    private readonly buckets = new Map<string, Bucket>();

    /** Acquire calls since the last sweep of the bucket table. */
    private callsSinceSweep = 0;

    /**
     * Creates a limiter.
     *
     * @param ratePerSecond - sustained requests per second and token
     * @param burst - requests a token may send at once
     * @param now - clock in milliseconds, injectable for tests
     * @throws Error when a limit is not a positive finite number
     */
    constructor(
        private readonly ratePerSecond: number,
        private readonly burst: number,
        private readonly now: () => number = Date.now
    ) {
        if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
            throw new Error("The rate limit per second must be a positive number.");
        }
        if (!Number.isFinite(burst) || burst < 1) {
            throw new Error("The rate limit burst must be at least 1.");
        }
    }

    /**
     * Consumes one request from the bucket of a token.
     *
     * @param token - the MCP user token
     * @throws Error with the retry delay when the bucket is empty
     */
    public acquire(token: string): void {
        const key = TokenDigest.sha256Hex(token);
        const current = this.now();
        // sweep before the lookup: a bucket dropped during the sweep is recreated full, which is equivalent
        this.sweepEveryInterval(current);
        const bucket = this.buckets.get(key) ?? { available: this.burst, updatedAt: current };
        const elapsedSeconds = Math.max(0, current - bucket.updatedAt) / 1000;
        bucket.available = Math.min(this.burst, bucket.available + elapsedSeconds * this.ratePerSecond);
        bucket.updatedAt = current;
        this.buckets.set(key, bucket);

        if (bucket.available < 1) {
            const retryAfter = Math.ceil((1 - bucket.available) / this.ratePerSecond);
            throw new Error(`rate limited, retry after ${retryAfter} s`);
        }
        bucket.available -= 1;
    }

    /** Runs a sweep on every SWEEP_INTERVAL-th call and does nothing on the others. */
    private sweepEveryInterval(current: number): void {
        this.callsSinceSweep++;
        if (this.callsSinceSweep < TokenRateLimiter.SWEEP_INTERVAL) {
            return;
        }
        this.callsSinceSweep = 0;
        this.dropFullBuckets(current);
    }

    /** Drops buckets that have refilled completely, as a fresh bucket would be full too. */
    private dropFullBuckets(current: number): void {
        for (const [key, bucket] of this.buckets) {
            const elapsedSeconds = Math.max(0, current - bucket.updatedAt) / 1000;
            if (bucket.available + elapsedSeconds * this.ratePerSecond >= this.burst) {
                this.buckets.delete(key);
            }
        }
    }
}
