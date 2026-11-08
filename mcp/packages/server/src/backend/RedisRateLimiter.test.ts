import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Redis from "ioredis";
import { RedisRateLimiter } from "./RedisRateLimiter";
import { TokenDigest } from "./TokenDigest";
import { RateLimitError, TokenRateLimiter } from "./TokenRateLimiter";

/** Redis URI of the test server, or undefined when the tests run without Redis. */
const testRedisUri = process.env.PENPOT_MCP_TEST_REDIS_URI?.trim() || undefined;
const skipWithoutRedis = testRedisUri === undefined ? "PENPOT_MCP_TEST_REDIS_URI is unset" : false;

/** Returns the test Redis URI; only called by tests that are skipped without it. */
function requireRedisUri(): string {
    if (testRedisUri === undefined) {
        throw new Error("PENPOT_MCP_TEST_REDIS_URI is unset");
    }
    return testRedisUri;
}

/** A port on which nothing listens, so every Redis call fails. */
const deadRedisUri = "redis://127.0.0.1:1";

/** Calls acquire the given number of times and returns how many were admitted. */
async function admit(limiter: RedisRateLimiter, token: string, count: number): Promise<number> {
    let admitted = 0;
    for (let i = 0; i < count; i++) {
        try {
            await limiter.acquire(token);
            admitted++;
        } catch (error) {
            if (!(error instanceof RateLimitError)) {
                throw error;
            }
        }
    }
    return admitted;
}

test("without Redis the calls fall back to the in-process bucket", async () => {
    const limiter = new RedisRateLimiter(deadRedisUri, 10, 20, new TokenRateLimiter(10, 20));
    const token = `token-${randomUUID()}`;
    try {
        assert.equal(await admit(limiter, token, 21), 20);
        assert.equal(limiter.fallbackCount, 21);
        await assert.rejects(() => limiter.acquire(token), {
            name: "RateLimitError",
            message: "rate limited, retry after 1 s",
        });
    } finally {
        await limiter.close();
    }
});

test("a dead-port limiter still falls back to the in-process bucket after construction", async () => {
    const limiter = new RedisRateLimiter(deadRedisUri, 10, 2, new TokenRateLimiter(10, 2));
    const token = `token-${randomUUID()}`;
    try {
        assert.equal(await admit(limiter, token, 3), 2);
        assert.equal(limiter.fallbackCount, 3);
    } finally {
        await limiter.close();
    }
});

test("the fallback refusal names the wait of the in-process bucket", async () => {
    const limiter = new RedisRateLimiter(deadRedisUri, 10, 1, new TokenRateLimiter(10, 1));
    const token = `token-${randomUUID()}`;
    try {
        await limiter.acquire(token);
        await assert.rejects(() => limiter.acquire(token), { message: "rate limited, retry after 1 s" });
        assert.equal(limiter.fallbackCount, 2);
    } finally {
        await limiter.close();
    }
});

test("two instances on one Redis share the bucket of a token", { skip: skipWithoutRedis }, async () => {
    const token = `token-${randomUUID()}`;
    const uri = requireRedisUri();
    const first = new RedisRateLimiter(uri, 1, 5, new TokenRateLimiter(1, 5));
    const second = new RedisRateLimiter(uri, 1, 5, new TokenRateLimiter(1, 5));
    try {
        const admitted = (await admit(first, token, 3)) + (await admit(second, token, 3));
        assert.equal(admitted, 5);
        await assert.rejects(() => first.acquire(token), RateLimitError);
        await assert.rejects(() => second.acquire(token), RateLimitError);
    } finally {
        await first.close();
        await second.close();
    }
});

test("a Redis that answers does not use the fallback", { skip: skipWithoutRedis }, async () => {
    const token = `token-${randomUUID()}`;
    const limiter = new RedisRateLimiter(requireRedisUri(), 1, 5, new TokenRateLimiter(1, 5));
    try {
        assert.equal(await admit(limiter, token, 5), 5);
        assert.equal(limiter.fallbackCount, 0);
        assert.equal(limiter.available, true);
    } finally {
        await limiter.close();
    }
});

test(
    "the token bucket command runs three calls in a row after the script cache is flushed",
    { skip: skipWithoutRedis },
    async () => {
        const token = `token-${randomUUID()}`;
        const uri = requireRedisUri();
        const limiter = new RedisRateLimiter(uri, 1, 5, new TokenRateLimiter(1, 5));
        const direct = new Redis(uri);
        try {
            // with the cache empty the first call gets NOSCRIPT and the script is sent in full
            await direct.script("FLUSH");
            assert.equal(await admit(limiter, token, 3), 3);
            assert.equal(limiter.fallbackCount, 0);
        } finally {
            await limiter.close();
            await direct.quit();
        }
    }
);

test("a fresh Redis bucket starts at the level of the local bucket", { skip: skipWithoutRedis }, async () => {
    const token = `token-${randomUUID()}`;
    const local = new TokenRateLimiter(1, 3);
    for (let i = 0; i < 3; i++) {
        local.record(token);
    }
    const limiter = new RedisRateLimiter(requireRedisUri(), 1, 3, local);
    try {
        await assert.rejects(() => limiter.acquire(token), RateLimitError);
        assert.equal(limiter.fallbackCount, 0);
    } finally {
        await limiter.close();
    }
});

test("calls admitted by Redis are mirrored into the local bucket", { skip: skipWithoutRedis }, async () => {
    const token = `token-${randomUUID()}`;
    const local = new TokenRateLimiter(1, 3);
    const limiter = new RedisRateLimiter(requireRedisUri(), 1, 3, local);
    try {
        assert.equal(await admit(limiter, token, 2), 2);
        // two of three tokens are used, so the local bucket has about one left
        assert.ok(local.levelOf(token) < 2, `expected about 1 token left, got ${local.levelOf(token)}`);
    } finally {
        await limiter.close();
    }
});

test("a dead-port limiter reports unavailable right after construction", async () => {
    const limiter = new RedisRateLimiter(deadRedisUri, 10, 20, new TokenRateLimiter(10, 20));
    try {
        assert.equal(limiter.available, false);
    } finally {
        await limiter.close();
    }
});

test("a failed Redis call marks the limiter unavailable", async () => {
    const limiter = new RedisRateLimiter(deadRedisUri, 10, 20, new TokenRateLimiter(10, 20));
    const token = `token-${randomUUID()}`;
    try {
        await limiter.acquire(token);
        assert.equal(limiter.available, false);
        assert.equal(limiter.fallbackCount, 1);
    } finally {
        await limiter.close();
    }
});

test("the bucket key expires within burst / rate + 1 seconds", { skip: skipWithoutRedis }, async () => {
    const token = `token-${randomUUID()}`;
    const uri = requireRedisUri();
    const limiter = new RedisRateLimiter(uri, 1, 5, new TokenRateLimiter(1, 5));
    const direct = new Redis(uri);
    try {
        await limiter.acquire(token);
        const key = `penpot.mcp.ratelimit.${TokenDigest.sha256Hex(token)}`;
        const ttl = await direct.ttl(key);
        assert.ok(ttl > 0, `expected a positive TTL, got ${ttl}`);
        assert.ok(ttl <= 6, `expected a TTL of at most 6 s, got ${ttl}`);
    } finally {
        await limiter.close();
        await direct.quit();
    }
});
