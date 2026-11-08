import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Redis from "ioredis";
import { PermitGate, type PermitWait } from "./PermitGate";
import { ExportPermitStore, RedisExportPermits, RedisExportPermitStore } from "./RedisExportPermits";

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

/**
 * In-memory store that mimics the Lua script: expired members are removed by their score against an injected
 * clock, and a take counts against the limit. A test can make its takes or gives-back throw.
 */
class FakeStore implements ExportPermitStore {
    /** Held permits, by member id, with the time at which each expires. */
    readonly members = new Map<string, number>();
    takeError: Error | undefined;
    freeError: Error | undefined;

    constructor(private readonly clock: () => number) {}

    /** Number of permits held at the moment, after the expired ones are removed. */
    get held(): number {
        this.removeExpired();
        return this.members.size;
    }

    async take(_key: string, member: string, limit: number, leaseMs: number): Promise<boolean> {
        if (this.takeError !== undefined) {
            throw this.takeError;
        }
        this.removeExpired();
        if (this.members.size < limit) {
            this.members.set(member, this.clock() + leaseMs);
            return true;
        }
        return false;
    }

    async free(_key: string, member: string): Promise<void> {
        if (this.freeError !== undefined) {
            throw this.freeError;
        }
        this.members.delete(member);
    }

    private removeExpired(): void {
        const now = this.clock();
        for (const [member, expiry] of this.members) {
            if (expiry <= now) {
                this.members.delete(member);
            }
        }
    }
}

/** Settles after a few milliseconds, so pending callbacks run. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
}

/** Busy text of the shared permits, read from the export gate, so the test fails if the two texts drift apart. */
async function busyTextOfPermitGate(waitMs: number): Promise<string> {
    const gate = new PermitGate("export", 1);
    await gate.acquire({ waitMs: 1_000 });
    try {
        await gate.acquire({ waitMs });
        return "";
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

test("a permit given back frees the slot for a waiting caller", async () => {
    let now = 0;
    const store = new FakeStore(() => now);
    const permits = new RedisExportPermits(store, 1, 60_000);
    const first = await permits.acquire({ waitMs: 1_000 });
    let secondGranted = false;
    const second = permits.acquire({ waitMs: 1_000 }).then((release) => {
        secondGranted = true;
        return release;
    });
    await settle();
    assert.equal(secondGranted, false);
    await first();
    const releaseSecond = await second;
    assert.equal(secondGranted, true);
    await releaseSecond();
    assert.equal(store.held, 0);
});

test("two adapters sharing one store never hold more than the limit at once", async () => {
    let now = 0;
    const store = new FakeStore(() => now);
    const limit = 2;
    const first = new RedisExportPermits(store, limit, 60_000);
    const second = new RedisExportPermits(store, limit, 60_000);
    let running = 0;
    let peak = 0;
    const run = async (permits: RedisExportPermits): Promise<void> => {
        const release = await permits.acquire({ waitMs: 5_000 });
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        await release();
    };
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
        jobs.push(run(first), run(second));
    }
    await Promise.all(jobs);
    assert.equal(peak, limit);
    assert.equal(store.held, 0);
});

test("a permit that is never given back is freed when its lease passes", async () => {
    let now = 1_000;
    const store = new FakeStore(() => now);
    const permits = new RedisExportPermits(store, 1, 500, { renderTimeoutMs: 100 });
    await permits.acquire({ waitMs: 1_000 });
    // the stale permit still holds the only slot, so a new caller is refused in time
    await assert.rejects(permits.acquire({ waitMs: 20 }), /export is busy/);
    now += 500;
    const release = await permits.acquire({ waitMs: 20 });
    await release();
});

test("a take that throws lets the call go on, logs once per outage, and counts the fallbacks", async () => {
    const store = new FakeStore(() => 0);
    store.takeError = new Error("connection refused");
    const warnings: string[] = [];
    const permits = new RedisExportPermits(store, 1, 60_000, {
        warn: (_error, message) => warnings.push(message),
    });
    for (let i = 0; i < 3; i++) {
        const release = await permits.acquire({ waitMs: 20 });
        await release();
    }
    assert.equal(warnings.length, 1);
    assert.equal(permits.fallbackCount, 3);
    assert.equal(store.held, 0);
});

test("the take warning is logged again after Redis answers and fails once more", async () => {
    const store = new FakeStore(() => 0);
    const warnings: string[] = [];
    const permits = new RedisExportPermits(store, 1, 60_000, {
        warn: (_error, message) => warnings.push(message),
    });
    store.takeError = new Error("down");
    await permits.acquire({ waitMs: 20 });
    store.takeError = undefined;
    const release = await permits.acquire({ waitMs: 20 });
    await release();
    store.takeError = new Error("down again");
    await permits.acquire({ waitMs: 20 });
    assert.equal(warnings.length, 2);
    assert.equal(permits.fallbackCount, 2);
});

test("a give-back that throws does not throw, and is logged once", async () => {
    const store = new FakeStore(() => 0);
    const warnings: string[] = [];
    const permits = new RedisExportPermits(store, 1, 60_000, {
        warn: (_error, message) => warnings.push(message),
    });
    const release = await permits.acquire({ waitMs: 20 });
    store.freeError = new Error("down");
    await release();
    // the failed give-back left the member in place; the lease would free it, so the test clears it the same way
    store.members.clear();
    store.freeError = undefined;
    const second = await permits.acquire({ waitMs: 20 });
    await second();
    assert.equal(warnings.length, 1);
    assert.equal(permits.fallbackCount, 0);
});

test("a call that waits longer than the budget is refused with the busy text of the export gate", async () => {
    const store = new FakeStore(() => 0);
    const permits = new RedisExportPermits(store, 1, 60_000);
    const release = await permits.acquire({ waitMs: 1_000 });
    await assert.rejects(
        permits.acquire({ waitMs: 30 }),
        /export is busy, retry later: no slot was free for 0\.03 seconds\./
    );
    assert.equal(await busyTextOfPermitGate(30), "export is busy, retry later: no slot was free for 0.03 seconds.");
    await release();
});

test("a caller whose signal fires while it waits gets the signal reason", async () => {
    const store = new FakeStore(() => 0);
    const permits = new RedisExportPermits(store, 1, 60_000);
    const release = await permits.acquire({ waitMs: 1_000 });
    const reason = new Error("the caller went away");
    const controller = new AbortController();
    const waiting = permits.acquire({ waitMs: 1_000, signal: controller.signal });
    await settle();
    controller.abort(reason);
    await assert.rejects(waiting, (error: unknown) => error === reason);
    await release();
    assert.equal(store.held, 0);
});

test("the Redis permit store takes and frees permits of one key", { skip: skipWithoutRedis }, async () => {
    const uri = requireRedisUri();
    const key = `penpot.mcp.test.permits.${randomUUID()}`;
    const first = new RedisExportPermitStore(uri);
    const second = new RedisExportPermitStore(uri);
    const direct = new Redis(uri);
    try {
        const one = randomUUID();
        assert.equal(await first.take(key, one, 1, 60_000), true);
        assert.equal(await second.take(key, randomUUID(), 1, 60_000), false);
        await first.free(key, one);
        assert.equal(await second.take(key, randomUUID(), 1, 60_000), true);
        assert.ok((await direct.pttl(key)) > 0);
    } finally {
        await direct.del(key);
        await first.close();
        await second.close();
        await direct.quit();
    }
});

test("a lease shorter than the render timeout is refused", () => {
    const store = new FakeStore(() => 0);
    assert.throws(() => new RedisExportPermits(store, 4, 59_999), /must cover the render timeout/);
    assert.doesNotThrow(() => new RedisExportPermits(store, 4, 60_000));
    assert.throws(() => new RedisExportPermits(store, 4, 9_000, { renderTimeoutMs: 10_000 }), /must cover/);
});

test("available is false while takes fail, and true again after one take succeeds", async () => {
    const store = new FakeStore(() => 0);
    const permits = new RedisExportPermits(store, 4, 65_000, { warn: () => undefined });
    assert.equal(permits.available, true);
    store.takeError = new Error("redis down");
    await permits.acquire({ waitMs: 1000, signal: undefined } as PermitWait);
    assert.equal(permits.available, false);
    store.takeError = undefined;
    const release = await permits.acquire({ waitMs: 1000, signal: undefined } as PermitWait);
    assert.equal(permits.available, true);
    await release();
});
