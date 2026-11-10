import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Redis from "ioredis";
import { PermitGate, type PermitWait } from "./PermitGate";
import { ExportPermitStore, RedisExportPermits, RedisExportPermitStore, waiterKeysOf } from "./RedisExportPermits";

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

/** A waiting caller in the fake store: the times of its first and its last take. */
interface FakeWaiter {
    /** Time of the first take, which sets the place in the queue. */
    since: number;
    /** Time of the last take. */
    seen: number;
}

/**
 * In-memory store that mimics the Lua script: expired members are removed by their score against an injected
 * clock, waiting callers keep their place in arrival order, and a take counts against the limit. A caller that has
 * not asked for the stale time loses its place. A test can make its takes, gives-back or leaves throw.
 */
class FakeStore implements ExportPermitStore {
    /** Held permits, by member id, with the time at which each expires. */
    readonly members = new Map<string, number>();
    /** Waiting callers, by member id. */
    readonly waiters = new Map<string, FakeWaiter>();
    takeError: Error | undefined;
    freeError: Error | undefined;
    leaveError: Error | undefined;

    constructor(private readonly clock: () => number) {}

    /** Number of permits held at the moment, after the expired ones are removed. */
    get held(): number {
        this.removeExpired();
        return this.members.size;
    }

    async take(_key: string, member: string, limit: number, leaseMs: number, staleMs: number): Promise<boolean> {
        if (this.takeError !== undefined) {
            throw this.takeError;
        }
        this.removeExpired();
        const now = this.clock();
        for (const [waiter, place] of this.waiters) {
            if (place.seen <= now - staleMs) {
                this.waiters.delete(waiter);
            }
        }
        const place = this.waiters.get(member);
        if (place === undefined) {
            this.waiters.set(member, { since: now, seen: now });
        } else {
            place.seen = now;
        }
        if (this.members.size < limit && this.rankOf(member) < limit - this.members.size) {
            this.waiters.delete(member);
            this.members.set(member, now + leaseMs);
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

    async leave(_key: string, member: string): Promise<void> {
        if (this.leaveError !== undefined) {
            throw this.leaveError;
        }
        this.waiters.delete(member);
    }

    /** Place of a waiting caller: by the time of its first take, then by member id. */
    private rankOf(member: string): number {
        const ordered = [...this.waiters].sort(([a, placeA], [b, placeB]) => {
            if (placeA.since !== placeB.since) {
                return placeA.since - placeB.since;
            }
            return a < b ? -1 : a > b ? 1 : 0;
        });
        return ordered.findIndex(([waiter]) => waiter === member);
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

/** Deletes the permit set of a test key and its waiter sets, so that a test leaves nothing behind. */
async function deleteTestKeys(key: string): Promise<void> {
    const direct = new Redis(requireRedisUri());
    try {
        const waiters = waiterKeysOf(key);
        await direct.del(key, waiters.waiters, waiters.seen);
    } finally {
        await direct.quit();
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

test("heldCount follows the shared permits that this process holds", async () => {
    const permits = new RedisExportPermits(new FakeStore(() => 0), 1, 60_000, { warn: () => undefined });
    assert.equal(permits.heldCount, 0);
    const release = await permits.acquire({ waitMs: 1_000 });
    assert.equal(permits.heldCount, 1);
    await release();
    assert.equal(permits.heldCount, 0);
    await release();
    assert.equal(permits.heldCount, 0);
});

test("heldCount ignores a take that falls back, and drops after a give-back that fails", async () => {
    const store = new FakeStore(() => 0);
    const permits = new RedisExportPermits(store, 1, 60_000, { warn: () => undefined });
    store.takeError = new Error("down");
    const fallback = await permits.acquire({ waitMs: 1_000 });
    assert.equal(permits.heldCount, 0);
    await fallback();
    assert.equal(permits.heldCount, 0);
    store.takeError = undefined;
    const release = await permits.acquire({ waitMs: 1_000 });
    assert.equal(permits.heldCount, 1);
    store.freeError = new Error("down");
    await release();
    assert.equal(permits.heldCount, 0);
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
        // the waiting caller keeps its member id between takes, so it keeps its place in the queue
        const two = randomUUID();
        assert.equal(await first.take(key, one, 1, 60_000, 3_000), true);
        assert.equal(await second.take(key, two, 1, 60_000, 3_000), false);
        await first.free(key, one);
        assert.equal(await second.take(key, two, 1, 60_000, 3_000), true);
        assert.ok((await direct.pttl(key)) > 0);
    } finally {
        await deleteTestKeys(key);
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

test("a caller that arrives later does not overtake a waiting caller", async () => {
    let now = 0;
    const store = new FakeStore(() => now);
    const permits = new RedisExportPermits(store, 1, 60_000);
    const releaseA = await permits.acquire({ waitMs: 1_000 });
    const waitingB = permits.acquire({ waitMs: 5_000 });
    await settle();
    now += 40;
    let cGranted = false;
    const waitingC = permits.acquire({ waitMs: 5_000 }).then((release) => {
        cGranted = true;
        return release;
    });
    await settle();
    await releaseA();
    const releaseB = await waitingB;
    await settle();
    assert.equal(cGranted, false);
    await releaseB();
    const releaseC = await waitingC;
    assert.equal(cGranted, true);
    await releaseC();
    assert.equal(store.held, 0);
});

test("one acquire keeps one member id across its takes", async () => {
    let now = 0;
    const store = new FakeStore(() => now);
    const takes: string[] = [];
    const takeOf = store.take.bind(store);
    store.take = (key, member, limit, leaseMs, staleMs) => {
        takes.push(member);
        return takeOf(key, member, limit, leaseMs, staleMs);
    };
    const permits = new RedisExportPermits(store, 1, 60_000);
    const release = await permits.acquire({ waitMs: 1_000 });
    takes.length = 0;
    await assert.rejects(permits.acquire({ waitMs: 100 }), /export is busy/);
    assert.ok(takes.length > 1);
    assert.equal(new Set(takes).size, 1);
    await release();
});

test("a caller whose wait budget ends leaves the queue", async () => {
    const store = new FakeStore(() => 0);
    const permits = new RedisExportPermits(store, 1, 60_000);
    const release = await permits.acquire({ waitMs: 1_000 });
    await assert.rejects(permits.acquire({ waitMs: 30 }), /export is busy/);
    assert.equal(store.waiters.size, 0);
    await release();
});

test("a caller whose signal fires leaves the queue", async () => {
    const store = new FakeStore(() => 0);
    const permits = new RedisExportPermits(store, 1, 60_000);
    const release = await permits.acquire({ waitMs: 1_000 });
    const reason = new Error("the caller went away");
    const controller = new AbortController();
    const waiting = permits.acquire({ waitMs: 1_000, signal: controller.signal });
    await settle();
    assert.equal(store.waiters.size, 1);
    controller.abort(reason);
    await assert.rejects(waiting, (error: unknown) => error === reason);
    assert.equal(store.waiters.size, 0);
    await release();
});

test("a leave that throws is ignored", async () => {
    const store = new FakeStore(() => 0);
    store.leaveError = new Error("down");
    const permits = new RedisExportPermits(store, 1, 60_000);
    const release = await permits.acquire({ waitMs: 1_000 });
    await assert.rejects(permits.acquire({ waitMs: 30 }), /export is busy/);
    await release();
});

test("a waiting caller that stopped asking loses its place, and the next caller is served", async () => {
    let now = 0;
    const store = new FakeStore(() => now);
    const permits = new RedisExportPermits(store, 1, 60_000);
    const release = await permits.acquire({ waitMs: 1_000 });
    const reason = new Error("the caller went away");
    const controller = new AbortController();
    const waitingB = permits.acquire({ waitMs: 10_000, signal: controller.signal });
    await settle();
    assert.equal(store.waiters.size, 1);
    // the leave fails, so B keeps its place in the queue after it has gone
    store.leaveError = new Error("down");
    controller.abort(reason);
    await assert.rejects(waitingB, (error: unknown) => error === reason);
    store.leaveError = undefined;
    assert.equal(store.waiters.size, 1);
    now += 3_001;
    const waitingC = permits.acquire({ waitMs: 10_000 });
    await settle();
    await release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("the next caller was not served within 2 seconds")), 2_000);
    });
    let releaseC: () => Promise<void>;
    try {
        releaseC = await Promise.race([waitingC, timeout]);
    } finally {
        clearTimeout(timer);
    }
    assert.equal(store.waiters.size, 0);
    assert.equal(store.held, 1);
    await releaseC();
    assert.equal(store.held, 0);
});

test("an aborted waiter does not block the callers behind it", async () => {
    let now = 0;
    const store = new FakeStore(() => now);
    const permits = new RedisExportPermits(store, 1, 60_000);
    const release = await permits.acquire({ waitMs: 1_000 });
    const reason = new Error("the caller went away");
    const controller = new AbortController();
    const waitingB = permits.acquire({ waitMs: 10_000, signal: controller.signal });
    await settle();
    now += 40;
    const waitingC = permits.acquire({ waitMs: 10_000 });
    await settle();
    assert.equal(store.waiters.size, 2);
    controller.abort(reason);
    await assert.rejects(waitingB, (error: unknown) => error === reason);
    assert.equal(store.waiters.size, 1);
    await release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("the next caller was not served within 2 seconds")), 2_000);
    });
    let releaseC: () => Promise<void>;
    try {
        releaseC = await Promise.race([waitingC, timeout]);
    } finally {
        clearTimeout(timer);
    }
    await releaseC();
    assert.equal(store.held, 0);
});

test("the Redis store grants permits in arrival order", { skip: skipWithoutRedis }, async () => {
    const key = `penpot.mcp.test.${randomUUID()}`;
    const store = new RedisExportPermitStore(requireRedisUri());
    const [m1, m2, m3] = [randomUUID(), randomUUID(), randomUUID()];
    try {
        assert.equal(await store.take(key, m1, 1, 60_000, 3_000), true);
        assert.equal(await store.take(key, m2, 1, 60_000, 3_000), false);
        await settle();
        assert.equal(await store.take(key, m3, 1, 60_000, 3_000), false);
        await store.free(key, m1);
        assert.equal(await store.take(key, m3, 1, 60_000, 3_000), false);
        assert.equal(await store.take(key, m2, 1, 60_000, 3_000), true);
        await store.free(key, m2);
        assert.equal(await store.take(key, m3, 1, 60_000, 3_000), true);
        await store.free(key, m3);
    } finally {
        await deleteTestKeys(key);
        await store.close();
    }
});

test("the Redis store drops a waiting caller that stopped asking", { skip: skipWithoutRedis }, async () => {
    const key = `penpot.mcp.test.${randomUUID()}`;
    const store = new RedisExportPermitStore(requireRedisUri());
    const [m1, m2, m3] = [randomUUID(), randomUUID(), randomUUID()];
    try {
        assert.equal(await store.take(key, m1, 1, 60_000, 100), true);
        assert.equal(await store.take(key, m2, 1, 60_000, 100), false);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await store.free(key, m1);
        assert.equal(await store.take(key, m3, 1, 60_000, 100), true);
        await store.free(key, m3);
    } finally {
        await deleteTestKeys(key);
        await store.close();
    }
});

test("the Redis store forgets a caller that leaves", { skip: skipWithoutRedis }, async () => {
    const key = `penpot.mcp.test.${randomUUID()}`;
    const store = new RedisExportPermitStore(requireRedisUri());
    const [m1, m2, m3] = [randomUUID(), randomUUID(), randomUUID()];
    try {
        assert.equal(await store.take(key, m1, 1, 60_000, 3_000), true);
        assert.equal(await store.take(key, m2, 1, 60_000, 3_000), false);
        await store.leave(key, m2);
        await store.free(key, m1);
        assert.equal(await store.take(key, m3, 1, 60_000, 3_000), true);
        await store.free(key, m3);
    } finally {
        await deleteTestKeys(key);
        await store.close();
    }
});

test("two free permits go to the first two waiting callers", { skip: skipWithoutRedis }, async () => {
    const key = `penpot.mcp.test.${randomUUID()}`;
    const store = new RedisExportPermitStore(requireRedisUri());
    const [m1, m2, m3, m4, m5] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    try {
        assert.equal(await store.take(key, m1, 2, 60_000, 3_000), true);
        assert.equal(await store.take(key, m2, 2, 60_000, 3_000), true);
        assert.equal(await store.take(key, m3, 2, 60_000, 3_000), false);
        await settle();
        assert.equal(await store.take(key, m4, 2, 60_000, 3_000), false);
        await settle();
        assert.equal(await store.take(key, m5, 2, 60_000, 3_000), false);
        await store.free(key, m1);
        await store.free(key, m2);
        assert.equal(await store.take(key, m5, 2, 60_000, 3_000), false);
        assert.equal(await store.take(key, m3, 2, 60_000, 3_000), true);
        assert.equal(await store.take(key, m4, 2, 60_000, 3_000), true);
        assert.equal(await store.take(key, m5, 2, 60_000, 3_000), false);
    } finally {
        await deleteTestKeys(key);
        await store.close();
    }
});
