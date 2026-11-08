import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Redis from "ioredis";
import { MemoryStorageStore, RedisStorageStore, type StorageLoad } from "./StorageStore";
import { STORAGE_LIMIT_BYTES } from "./SandboxWorkerProtocol";

/** Redis URI of the tests that need a server, or undefined when the tests are skipped. */
const REDIS_URI = process.env.PENPOT_MCP_TEST_REDIS_URI?.trim() || undefined;
const REDIS_SKIP = REDIS_URI === undefined ? "PENPOT_MCP_TEST_REDIS_URI is unset" : false;

/** Text just above the storage limit, which every store refuses. */
const OVERSIZED = "x".repeat(STORAGE_LIMIT_BYTES + 1);

/** Clock that the test moves by hand. */
class FakeClock {
    /** Current instant, in milliseconds. */
    public current = 0;

    now = (): number => this.current;
}

/**
 * Returns the text of a read, or undefined when the read holds no value.
 *
 * @param load - result of a read
 * @returns the saved text, or undefined
 */
function textOf(load: StorageLoad): string | undefined {
    return load.kind === "value" ? load.text : undefined;
}

test("memory store returns the saved text of a key", async () => {
    const store = new MemoryStorageStore(10, 60_000);
    assert.equal(store.shared, false);
    assert.deepEqual(await store.load("k"), { kind: "absent" });
    assert.equal(await store.save("k", '{"a":1}'), true);
    assert.deepEqual(await store.load("k"), { kind: "value", text: '{"a":1}' });
    await store.close();
});

test("memory store expires an entry after the time to live, counted from the last write", async () => {
    const clock = new FakeClock();
    const store = new MemoryStorageStore(10, 1000, clock.now);
    await store.save("k", "1");
    clock.current = 999;
    assert.equal(textOf(await store.load("k")), "1");
    await store.save("k", "2");
    clock.current = 1998;
    assert.equal(textOf(await store.load("k")), "2");
    clock.current = 2000;
    assert.deepEqual(await store.load("k"), { kind: "absent" });
    assert.equal(store.size, 0);
});

test("memory store drops the oldest write when it holds more entries than its bound", async () => {
    const store = new MemoryStorageStore(2, 60_000);
    await store.save("a", "1");
    await store.save("b", "2");
    await store.save("a", "3");
    await store.save("c", "4");
    assert.deepEqual(await store.load("b"), { kind: "absent" }, "b was written before c and a");
    assert.equal(textOf(await store.load("a")), "3");
    assert.equal(textOf(await store.load("c")), "4");
    assert.equal(store.size, 2);
});

test("memory store refuses a text above the storage limit and keeps the old copy", async () => {
    const store = new MemoryStorageStore(10, 60_000);
    await store.save("k", "old");
    assert.equal(await store.save("k", OVERSIZED), false);
    assert.equal(textOf(await store.load("k")), "old");
    assert.equal(await store.save("fresh", OVERSIZED), false);
    assert.deepEqual(await store.load("fresh"), { kind: "absent" });
});

test("memory store clear drops every entry", async () => {
    const store = new MemoryStorageStore(10, 60_000);
    await store.save("a", "1");
    await store.save("b", "2");
    store.clear();
    assert.deepEqual(await store.load("a"), { kind: "absent" });
    assert.deepEqual(await store.load("b"), { kind: "absent" });
    assert.equal(store.size, 0);
});

test("redis store round trips a saved text and deletes it", { skip: REDIS_SKIP }, async () => {
    const store = new RedisStorageStore(REDIS_URI ?? "", 60_000);
    const key = randomUUID();
    try {
        assert.equal(store.shared, true);
        await store.whenReady();
        assert.deepEqual(await store.load(key), { kind: "absent" });
        assert.equal(await store.save(key, '{"b":2}'), true);
        assert.deepEqual(await store.load(key), { kind: "value", text: '{"b":2}' });
        await store.delete(key);
        assert.deepEqual(await store.load(key), { kind: "absent" });
    } finally {
        await store.delete(key);
        await store.close();
    }
});

test("redis store sets the time to live on every write", { skip: REDIS_SKIP }, async () => {
    const ttlMs = 5000;
    const store = new RedisStorageStore(REDIS_URI ?? "", ttlMs);
    const key = randomUUID();
    const raw = new Redis(REDIS_URI ?? "");
    try {
        await store.whenReady();
        await store.save(key, "{}");
        const pttl = await raw.pttl(`penpot.mcp.sandbox.storage.${key}`);
        assert.ok(pttl > 0, `PTTL is ${pttl}`);
        assert.ok(pttl <= ttlMs, `PTTL is ${pttl}, above ${ttlMs}`);
    } finally {
        await store.delete(key);
        await raw.quit();
        await store.close();
    }
});

test("redis store refuses a text above the storage limit and writes nothing", { skip: REDIS_SKIP }, async () => {
    const store = new RedisStorageStore(REDIS_URI ?? "", 60_000);
    const key = randomUUID();
    const other = randomUUID();
    try {
        await store.whenReady();
        assert.equal(await store.save(key, OVERSIZED), false);
        assert.deepEqual(await store.load(key), { kind: "absent" });
        await store.save(other, "old");
        assert.equal(await store.save(other, OVERSIZED), false);
        assert.equal(textOf(await store.load(other)), "old");
    } finally {
        await store.delete(key);
        await store.delete(other);
        await store.close();
    }
});

test("redis store reports an unavailable read, not an absent one, when Redis is down", async () => {
    const store = new RedisStorageStore("redis://127.0.0.1:1", 60_000);
    try {
        assert.deepEqual(await store.load("k"), { kind: "unavailable" });
        assert.equal(await store.save("k", "{}"), false);
        await store.delete("k");
        assert.deepEqual(await store.load("k"), { kind: "unavailable" });
    } finally {
        await store.close();
    }
});

test("redis store reports an unavailable read when the client throws on read", async () => {
    const store = new RedisStorageStore("redis://127.0.0.1:1", 60_000);
    const realClient = (store as unknown as { client: unknown }).client;
    try {
        await store.whenReady();
        (store as unknown as { client: unknown }).client = {
            get: async () => {
                throw new Error("connection lost");
            },
        };
        assert.deepEqual(await store.load("k"), { kind: "unavailable" });
    } finally {
        (store as unknown as { client: unknown }).client = realClient;
        await store.close();
    }
});
