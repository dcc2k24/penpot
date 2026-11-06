import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter } from "./Runner.js";

test("one rate limiter spaces the calls of an agent across steps, not per step", async () => {
    const limiter = new RateLimiter();
    const started = performance.now();
    // four calls at 20 per second: the calls wait 0, 50 and 100 ms, and the unlimited call adds no wait
    await limiter.wait(20);
    await limiter.wait(undefined);
    await limiter.wait(20);
    await limiter.wait(20);
    assert.ok(performance.now() - started >= 90, "the spacing carries across the steps");
});

test("a call with no rate is not delayed", async () => {
    const limiter = new RateLimiter();
    const started = performance.now();
    for (let call = 0; call < 5; call++) {
        await limiter.wait(undefined);
    }
    assert.ok(performance.now() - started < 50);
});
