import { TokenDigest } from "./TokenDigest";

/** Token bucket of one MCP token. */
interface Bucket {
    /** Tokens left, possibly fractional. */
    available: number;
    /** Instant of the last refill, in milliseconds. */
    updatedAt: number;
}

/** Error raised when a token has used its bucket; the caller should retry later. */
export class RateLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RateLimitError";
    }
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
        bucket.available = this.refilledLevel(bucket, current);
        bucket.updatedAt = current;
        this.buckets.set(key, bucket);

        if (bucket.available < 1) {
            const retryAfter = Math.ceil((1 - bucket.available) / this.ratePerSecond);
            throw new RateLimitError(`rate limited, retry after ${retryAfter} s`);
        }
        bucket.available -= 1;
    }

    /**
     * Reads how many requests a token may still send now, refilled up to the burst.
     *
     * @param token - the MCP user token
     * @returns the tokens left, the burst for a token that is not known yet
     */
    public levelOf(token: string): number {
        const bucket = this.buckets.get(TokenDigest.sha256Hex(token));
        if (bucket === undefined) {
            return this.burst;
        }
        return this.refilledLevel(bucket, this.now());
    }

    /**
     * Consumes one request of a token without refusing it. Used to mirror requests that another limiter
     * admitted, so this bucket reflects them. When no request is left, nothing is consumed.
     *
     * @param token - the MCP user token
     */
    public record(token: string): void {
        const key = TokenDigest.sha256Hex(token);
        const current = this.now();
        this.sweepEveryInterval(current);
        const bucket = this.buckets.get(key) ?? { available: this.burst, updatedAt: current };
        bucket.available = this.refilledLevel(bucket, current);
        bucket.updatedAt = current;
        this.buckets.set(key, bucket);
        if (bucket.available >= 1) {
            bucket.available -= 1;
        }
    }

    /** Tokens of a bucket at the given instant, refilled at the rate and capped at the burst. */
    private refilledLevel(bucket: Bucket, current: number): number {
        const elapsedSeconds = Math.max(0, current - bucket.updatedAt) / 1000;
        return Math.min(this.burst, bucket.available + elapsedSeconds * this.ratePerSecond);
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
    /** Number of token buckets held, for the metrics and the tests. */
    public get size(): number {
        return this.buckets.size;
    }
}
