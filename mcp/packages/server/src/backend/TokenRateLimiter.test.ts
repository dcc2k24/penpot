import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenRateLimiter } from "./TokenRateLimiter";

/** A clock whose time the test moves by hand. */
class ManualClock {
    public now = 0;

    public read = (): number => this.now;
}

/** Calls acquire the given number of times and returns how many were admitted. */
function admit(limiter: TokenRateLimiter, token: string, count: number): number {
    let admitted = 0;
    for (let i = 0; i < count; i++) {
        try {
            limiter.acquire(token);
            admitted++;
        } catch {
            // refused: counted by the difference
        }
    }
    return admitted;
}

test("admits a burst of 20 requests and refuses the 21st", () => {
    const limiter = new TokenRateLimiter(10, 20, new ManualClock().read);
    assert.equal(admit(limiter, "alice", 25), 20);
});

test("refusal names the wait until the next request in whole seconds", () => {
    const limiter = new TokenRateLimiter(10, 20, new ManualClock().read);
    admit(limiter, "alice", 20);
    assert.throws(() => limiter.acquire("alice"), { message: "rate limited, retry after 1 s" });
});

test("refusal waits longer for a slower rate", () => {
    const limiter = new TokenRateLimiter(0.5, 1, new ManualClock().read);
    limiter.acquire("alice");
    assert.throws(() => limiter.acquire("alice"), { message: "rate limited, retry after 2 s" });
});

test("tokens refill at the configured rate", () => {
    const clock = new ManualClock();
    const limiter = new TokenRateLimiter(10, 20, clock.read);
    admit(limiter, "alice", 20);
    clock.now = 1000;
    assert.equal(admit(limiter, "alice", 15), 10);
});

test("refill never exceeds the burst", () => {
    const clock = new ManualClock();
    const limiter = new TokenRateLimiter(10, 20, clock.read);
    clock.now = 60_000;
    assert.equal(admit(limiter, "alice", 30), 20);
});

test("each token has its own bucket", () => {
    const limiter = new TokenRateLimiter(10, 20, new ManualClock().read);
    admit(limiter, "alice", 20);
    assert.equal(admit(limiter, "bob", 20), 20);
});

/** Number of buckets held by a limiter, read through its private table. */
function bucketCount(limiter: TokenRateLimiter): number {
    return (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size;
}

test("full buckets are dropped by the sweep on the 256th call, not earlier", () => {
    const clock = new ManualClock();
    const limiter = new TokenRateLimiter(10, 20, clock.read);
    admit(limiter, "alice", 1);
    clock.now = 60_000;
    // bob stays drained, so his bucket must survive the sweep
    admit(limiter, "bob", 254);
    assert.equal(bucketCount(limiter), 2);
    admit(limiter, "bob", 1);
    assert.equal(bucketCount(limiter), 1);
});

test("a full bucket used during the sweep still admits a full burst", () => {
    const clock = new ManualClock();
    const limiter = new TokenRateLimiter(10, 20, clock.read);
    admit(limiter, "alice", 1);
    clock.now = 60_000;
    admit(limiter, "bob", 254);
    // the first alice call is the 256th and runs the sweep, which must not add tokens to alice
    assert.equal(admit(limiter, "alice", 25), 20);
});

test("record consumes one request, so the next acquire is refused after the burst", () => {
    const limiter = new TokenRateLimiter(10, 2, new ManualClock().read);
    limiter.record("alice");
    assert.equal(admit(limiter, "alice", 5), 1);
});

test("record never throws and consumes nothing at zero", () => {
    const limiter = new TokenRateLimiter(10, 2, new ManualClock().read);
    admit(limiter, "alice", 2);
    assert.equal(limiter.levelOf("alice"), 0);
    assert.doesNotThrow(() => limiter.record("alice"));
    assert.equal(limiter.levelOf("alice"), 0);
});

test("levelOf reports the burst for an unknown token and the refilled level otherwise", () => {
    const clock = new ManualClock();
    const limiter = new TokenRateLimiter(10, 20, clock.read);
    assert.equal(limiter.levelOf("alice"), 20);
    admit(limiter, "alice", 20);
    assert.equal(limiter.levelOf("alice"), 0);
    clock.now = 1000;
    assert.equal(limiter.levelOf("alice"), 10);
    clock.now = 60_000;
    assert.equal(limiter.levelOf("alice"), 20);
});

test("rejects non-positive limits", () => {
    assert.throws(() => new TokenRateLimiter(0, 20), /rate limit per second/);
    assert.throws(() => new TokenRateLimiter(10, 0), /burst/);
});
