import Redis from "ioredis";
import { createLogger } from "../logger";
import type { RateLimiter } from "./RateLimiter";
import { TokenDigest } from "./TokenDigest";
import { RateLimitError, TokenRateLimiter } from "./TokenRateLimiter";

/**
 * Token bucket kept in Redis, so that every MCP instance shares one count per token.
 * The script runs as one step, so two instances cannot both take the last token.
 */
const TOKEN_BUCKET_SCRIPT = `-- KEYS[1]: bucket key. ARGV[1]: refill per second. ARGV[2]: burst.
-- ARGV[3]: tokens a new bucket starts with, burst when missing.
-- Returns {allowed, waitSeconds}; allowed is 1 or 0.
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
local state = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(state[1])
local updated = tonumber(state[2])
if tokens == nil or updated == nil then
  tokens = math.min(burst, tonumber(ARGV[3]) or burst)
  updated = now
end
local elapsed = math.max(0, now - updated) / 1000
tokens = math.min(burst, tokens + elapsed * rate)
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.max(1, math.ceil((1 - tokens) / rate))
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updatedAt', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
return {allowed, wait}`;

/** A Redis client with the token bucket script registered as the tokenBucket command. */
type BucketClient = Redis & {
    tokenBucket(key: string, rate: string, burst: string, initial: string): Promise<unknown>;
};

/**
 * Limits the request rate of each MCP token across all instances, with a Redis token bucket.
 *
 * When Redis cannot answer, the request is judged by an in-process bucket instead, so an outage
 * of Redis does not fail the calls. Each instance then limits on its own until Redis is back.
 */
export class RedisRateLimiter implements RateLimiter {
    private static readonly KEY_PREFIX = "penpot.mcp.ratelimit.";

    private readonly logger = createLogger("RedisRateLimiter");
    private readonly client: Redis;
    /** The same client, typed with the registered script command. */
    private readonly bucket: BucketClient;
    /** Settles when the first connection attempt succeeds or fails. */
    private readonly firstAttempt: Promise<void>;
    /** Number of calls judged by the in-process bucket because Redis failed. */
    private fallbacks = 0;
    /** True while Redis is failing, so the warning is logged once per outage. */
    private failing = false;

    /**
     * Creates a limiter that keeps its buckets in Redis.
     *
     * @param redisUri - Redis connection URI (`redis:` or `rediss:`)
     * @param ratePerSecond - sustained requests per second and token
     * @param burst - requests a token may send at once
     * @param fallback - in-process limiter used while Redis cannot answer
     * @throws Error when a limit is not a positive finite number
     */
    constructor(
        redisUri: string,
        private readonly ratePerSecond: number,
        private readonly burst: number,
        private readonly fallback: TokenRateLimiter
    ) {
        if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
            throw new Error("The rate limit per second must be a positive number.");
        }
        if (!Number.isFinite(burst) || burst < 1) {
            throw new Error("The rate limit burst must be at least 1.");
        }
        // a dead Redis fails a call at once instead of queuing it behind a reconnect
        this.client = new Redis(redisUri, {
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            connectTimeout: 2000,
            // a hung Redis must not hold a request, so a command gives up and the fallback judges it
            commandTimeout: 2000,
        });
        // registered as a command, so ioredis sends a SHA1 (EVALSHA) and the full script only when Redis lacks it
        this.client.defineCommand("tokenBucket", { numberOfKeys: 1, lua: TOKEN_BUCKET_SCRIPT });
        this.bucket = this.client as BucketClient;
        // failed commands report the error; the connection events need no listener of their own
        this.client.on("error", () => undefined);
        // the first calls wait for the first connection attempt, since queuing is off and would refuse them
        this.firstAttempt = new Promise<void>((resolve) => {
            this.client.once("ready", () => resolve());
            this.client.once("error", () => resolve());
        });
    }

    /** Number of calls judged by the in-process bucket because Redis failed. */
    public get fallbackCount(): number {
        return this.fallbacks;
    }

    /**
     * True when the Redis connection is ready. False before the first connection and during an outage, so a
     * limiter that never reached Redis does not report itself as up.
     */
    public get available(): boolean {
        return this.client.status === "ready";
    }

    /**
     * Consumes one request of a token, in Redis or, when Redis fails, in the in-process bucket.
     *
     * @param token - the MCP user token
     * @throws RateLimitError when the token has no request left
     */
    public async acquire(token: string): Promise<void> {
        const key = `${RedisRateLimiter.KEY_PREFIX}${TokenDigest.sha256Hex(token)}`;
        // a new Redis bucket starts at the level of the local bucket, so a recovered Redis does not hand out a full burst
        const initial = this.fallback.levelOf(token);
        let decision: { allowed: boolean; wait: number };
        try {
            await this.firstAttempt;
            const reply = await this.bucket.tokenBucket(
                key,
                String(this.ratePerSecond),
                String(this.burst),
                String(initial)
            );
            decision = RedisRateLimiter.parseReply(reply);
        } catch (error) {
            this.recordFailure(error);
            this.fallback.acquire(token);
            return;
        }
        this.failing = false;
        if (!decision.allowed) {
            throw new RateLimitError(`rate limited, retry after ${decision.wait} s`);
        }
        // keeps the local bucket in step with the admissions of this process
        this.fallback.record(token);
    }

    /** Closes the Redis connection. Call it when the limiter is no longer used. */
    public async close(): Promise<void> {
        try {
            await this.client.quit();
        } catch {
            // a client that never connected cannot quit, so drop it
            this.client.disconnect();
        }
    }

    /** Counts a Redis failure and logs the first one of an outage. */
    private recordFailure(error: unknown): void {
        this.fallbacks++;
        if (!this.failing) {
            this.failing = true;
            this.logger.warn(error, "Redis rate limit unavailable, using the in-process bucket");
        }
    }

    /**
     * Reads the script reply, a pair of integers.
     *
     * @param reply - the value the script returned
     * @throws Error when the reply does not have the expected shape
     */
    private static parseReply(reply: unknown): { allowed: boolean; wait: number } {
        if (
            !Array.isArray(reply) ||
            reply.length !== 2 ||
            typeof reply[0] !== "number" ||
            typeof reply[1] !== "number"
        ) {
            throw new Error("Unexpected reply from the Redis rate limit script.");
        }
        return { allowed: reply[0] === 1, wait: reply[1] };
    }
}
