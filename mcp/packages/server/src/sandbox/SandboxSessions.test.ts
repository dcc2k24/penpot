import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxRuntime, SandboxRuntimeError, type SandboxHostCalls } from "./SandboxRuntime";
import { STORAGE_UNAVAILABLE_NOTICE, SandboxSessions } from "./SandboxSessions";
import { SandboxSettings } from "./SandboxSettings";
import type { GuestRuntime } from "./GuestRuntime";
import { MemoryStorageStore, RedisStorageStore, type StorageLoad, type StorageStore } from "./StorageStore";
import { createHash, randomUUID } from "node:crypto";
import Redis from "ioredis";

/** Redis URI of the tests that need a server, or undefined when the tests are skipped. */
const REDIS_URI = process.env.PENPOT_MCP_TEST_REDIS_URI?.trim() || undefined;
const REDIS_SKIP = REDIS_URI === undefined ? "PENPOT_MCP_TEST_REDIS_URI is unset" : false;

/** Host that rejects every primitive, for tests that never call one. */
const UNUSED_HOST: SandboxHostCalls = {
    async loadFileOutline(): Promise<string> {
        throw new Error("unused");
    },
    async loadPage(): Promise<string> {
        throw new Error("unused");
    },
    async flush(): Promise<string> {
        throw new Error("unused");
    },
    async importSvg(): Promise<string> {
        throw new Error("unused");
    },
    async rpc(): Promise<string> {
        throw new Error("unused");
    },
    async exportShape(): Promise<string> {
        throw new Error("unused");
    },
    async uploadMediaUrl(): Promise<string> {
        throw new Error("unused");
    },
    async uploadMediaData(): Promise<string> {
        throw new Error("unused");
    },
};

/** Clock that the test moves by hand. */
class FakeClock {
    /** Current instant, in milliseconds. */
    public current = 0;

    now = (): number => this.current;
}

test("the same key reuses its runtime and different keys get separate runtimes", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(), () => SandboxRuntime.create(""));
    try {
        const first = await sessions.acquire("token-a");
        const again = await sessions.acquire("token-a");
        const other = await sessions.acquire("token-b");
        assert.equal(first, again);
        assert.notEqual(first, other);
        assert.equal(sessions.size, 2);
    } finally {
        sessions.dispose();
    }
});

test("concurrent acquisitions of one key create a single runtime", async () => {
    let created = 0;
    const sessions = new SandboxSessions(new SandboxSettings(), async () => {
        created += 1;
        return SandboxRuntime.create("");
    });
    try {
        const runtimes = await Promise.all([sessions.acquire("k"), sessions.acquire("k"), sessions.acquire("k")]);
        assert.equal(created, 1);
        assert.equal(runtimes[0], runtimes[1]);
        assert.equal(runtimes[1], runtimes[2]);
    } finally {
        sessions.dispose();
    }
});

test("discard disposes the runtime of a key and forgets it", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(), () => SandboxRuntime.create(""));
    try {
        const runtime = await sessions.acquire("k");
        sessions.discard("k");
        assert.equal(runtime.disposed, true);
        assert.equal(sessions.size, 0);
    } finally {
        sessions.dispose();
    }
});

test("a poisoned runtime is replaced on the next acquisition", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(), () =>
        SandboxRuntime.create("function run() { while (true) {} }")
    );
    try {
        const poisoned = await sessions.acquire("k");
        await assert.rejects(poisoned.invoke("run", [], UNUSED_HOST, 100), SandboxRuntimeError);
        assert.equal(poisoned.poisoned, true);
        const replacement = await sessions.acquire("k");
        assert.notEqual(replacement, poisoned);
        assert.equal(poisoned.disposed, true);
        assert.equal(replacement.poisoned, false);
    } finally {
        sessions.dispose();
    }
});

test("a runtime spent by a memory bomb is recycled, and the next script runs in a fresh one", async () => {
    const bomb =
        "function bomb() { const hoard = []; try { while (true) { hoard.push(new Array(1000000).fill(7)); } }" +
        ' catch (e) { return String(e); } } function ok() { return "ok"; }';
    const sessions = new SandboxSessions(new SandboxSettings(), () =>
        SandboxRuntime.create(bomb, { memoryLimitBytes: 32 * 1024 * 1024 })
    );
    try {
        const first = await sessions.acquire("k");
        const live = SandboxRuntime.liveCount();
        assert.ok((await first.invoke("bomb", [], UNUSED_HOST, 10_000)).includes("out of memory"));
        assert.equal(sessions.recycleIfSpent("k"), true);
        assert.equal(first.disposed, true);
        assert.equal(sessions.size, 0);
        assert.equal(SandboxRuntime.liveCount(), live - 1);
        const next = await sessions.acquire("k");
        assert.notEqual(next, first);
        assert.equal(await next.invoke("ok", [], UNUSED_HOST, 1000), "ok");
        assert.equal(sessions.recycleIfSpent("k"), false);
        assert.equal(next.spent, false);
        assert.equal(sessions.size, 1);
    } finally {
        sessions.dispose();
    }
});

test("a spent runtime is replaced on the next acquisition and dropped by the sweep", async () => {
    const bomb =
        "function bomb() { const hoard = []; try { while (true) { hoard.push(new Array(1000000).fill(7)); } }" +
        " catch (e) { return String(e); } }";
    const sessions = new SandboxSessions(new SandboxSettings(), () =>
        SandboxRuntime.create(bomb, { memoryLimitBytes: 32 * 1024 * 1024 })
    );
    try {
        const first = await sessions.acquire("a");
        await first.invoke("bomb", [], UNUSED_HOST, 10_000);
        const replacement = await sessions.acquire("a");
        assert.notEqual(replacement, first);
        assert.equal(first.disposed, true);
        const other = await sessions.acquire("b");
        await other.invoke("bomb", [], UNUSED_HOST, 10_000);
        assert.equal(sessions.sweepIdle(), 1);
        assert.equal(other.disposed, true);
        assert.equal(sessions.size, 1);
    } finally {
        sessions.dispose();
    }
});

test("the idle sweep disposes only the runtimes unused for the eviction time", async () => {
    const clock = new FakeClock();
    const sessions = new SandboxSessions(new SandboxSettings(10_000, 1000), () => SandboxRuntime.create(""), clock.now);
    try {
        const idle = await sessions.acquire("idle");
        clock.current = 800;
        const busy = await sessions.acquire("busy");
        clock.current = 1500;
        assert.equal(sessions.sweepIdle(), 1);
        assert.equal(idle.disposed, true);
        assert.equal(busy.disposed, false);
        assert.equal(sessions.size, 1);
        clock.current = 3000;
        assert.equal(sessions.sweepIdle(), 1);
        assert.equal(sessions.size, 0);
    } finally {
        sessions.dispose();
    }
});

test("the least recently used runtime is disposed when the session limit is exceeded", async () => {
    const clock = new FakeClock();
    const sessions = new SandboxSessions(
        new SandboxSettings(10_000, 60_000, 120_000, 1000, 2),
        () => SandboxRuntime.create(""),
        clock.now
    );
    try {
        clock.current = 0;
        const first = await sessions.acquire("first");
        clock.current = 1;
        await sessions.acquire("second");
        clock.current = 2;
        await sessions.acquire("third");
        assert.equal(first.disposed, true);
        assert.equal(sessions.size, 2);
        clock.current = 3;
        const again = await sessions.acquire("first");
        assert.notEqual(again, first);
        assert.equal(again.disposed, false);
    } finally {
        sessions.dispose();
    }
});

test("acquiring a key refreshes its recency before the eviction", async () => {
    const clock = new FakeClock();
    const sessions = new SandboxSessions(
        new SandboxSettings(10_000, 60_000, 120_000, 1000, 2),
        () => SandboxRuntime.create(""),
        clock.now
    );
    try {
        clock.current = 0;
        const first = await sessions.acquire("first");
        clock.current = 1;
        const second = await sessions.acquire("second");
        clock.current = 2;
        assert.equal(await sessions.acquire("first"), first);
        clock.current = 3;
        await sessions.acquire("third");
        assert.equal(first.disposed, false);
        assert.equal(second.disposed, true);
        assert.equal(sessions.size, 2);
    } finally {
        sessions.dispose();
    }
});

test("ties in recency go to the entry inserted first", async () => {
    const clock = new FakeClock();
    const sessions = new SandboxSessions(
        new SandboxSettings(10_000, 60_000, 120_000, 1000, 2),
        () => SandboxRuntime.create(""),
        clock.now
    );
    try {
        const first = await sessions.acquire("first");
        const second = await sessions.acquire("second");
        const third = await sessions.acquire("third");
        assert.equal(first.disposed, true);
        assert.equal(second.disposed, false);
        assert.equal(third.disposed, false);
        assert.equal(sessions.size, 2);
    } finally {
        sessions.dispose();
    }
});

test("dispose releases every runtime and leaves no live runtime", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(), () => SandboxRuntime.create(""));
    await sessions.acquire("a");
    await sessions.acquire("b");
    sessions.start();
    sessions.dispose();
    assert.equal(sessions.size, 0);
    assert.equal(SandboxRuntime.liveCount(), 0);
    await assert.rejects(sessions.acquire("c"), /disposed/);
});

test("one token runs one script at a time, with two more queued; the next is refused as busy", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(), () => SandboxRuntime.create(""));
    try {
        const running = await sessions.acquireTurn("alice");
        const waitingOne = sessions.acquireTurn("alice");
        const waitingTwo = sessions.acquireTurn("alice");
        await assert.rejects(sessions.acquireTurn("alice"), { message: /is busy/ });
        // another token has its own turn and is not held up.
        const other = await sessions.acquireTurn("bob");
        other();
        running();
        (await waitingOne)();
        (await waitingTwo)();
    } finally {
        sessions.dispose();
    }
});

test("stats count runtimes created, disposed, recycled and calls by outcome", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(), () => SandboxRuntime.create(""));
    try {
        await sessions.acquire("alice");
        sessions.recordOutcome("ok");
        sessions.recordOutcome("interrupted");
        const stats = sessions.stats();
        assert.equal(stats.live, 1);
        assert.equal(stats.created, 1);
        assert.equal(stats.interrupted, 1);
        assert.equal(stats.calls.ok, 1);
        assert.equal(stats.calls.interrupted, 1);
        sessions.discard("alice");
        assert.equal(sessions.stats().disposed, 1);
        assert.equal(sessions.stats().live, 0);
    } finally {
        sessions.dispose();
    }
});

test("stop disposes every runtime, and a later acquisition creates a fresh one", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(), () => SandboxRuntime.create(""));
    try {
        const first = await sessions.acquire("alice");
        sessions.stop();
        assert.equal(first.disposed, true);
        assert.equal(sessions.size, 0);
        const second = await sessions.acquire("alice");
        assert.notEqual(second, first);
    } finally {
        sessions.dispose();
    }
});

/** Runtime that keeps only its storage text, for tests of the registry. */
class FakeRuntime implements GuestRuntime {
    public disposed = false;
    public poisoned = false;
    public spent = false;
    public wasmMemoryBytes = 0;
    public storageSnapshot: string | undefined;
    /** Text given to {@link restoreStorage}, or undefined when none was given. */
    public restored: string | undefined = undefined;

    /**
     * Creates a runtime with a storage text.
     *
     * @param storage - storage text the runtime starts with
     */
    constructor(storage?: string) {
        this.storageSnapshot = storage;
    }

    /**
     * Sets the storage text that the runtime reports.
     *
     * @param text - storage as JSON text
     */
    public setStorage(text: string): void {
        this.storageSnapshot = text;
    }

    /**
     * Records the text that the runtime restores.
     *
     * @param text - storage as JSON text
     */
    public restoreStorage(text: string): void {
        this.restored = text;
        this.storageSnapshot = text;
    }

    /** Not used by these tests. */
    public invoke(): Promise<string> {
        return Promise.reject(new Error("not used by these tests"));
    }

    /** Not used by these tests. */
    public takeNotice(): string | undefined {
        return undefined;
    }

    /** Marks the runtime as disposed. */
    public dispose(): void {
        this.disposed = true;
    }
}

test("a runtime that replaces a discarded one starts with its saved storage", async () => {
    const clock = new FakeClock();
    const store = new MemoryStorageStore(10, 60_000, clock.now);
    const runtimes: FakeRuntime[] = [];
    const sessions = new SandboxSessions(
        new SandboxSettings(),
        async () => {
            const runtime = new FakeRuntime();
            runtimes.push(runtime);
            return runtime;
        },
        clock.now,
        store
    );
    try {
        await sessions.acquire("k");
        runtimes[0].setStorage('{"n":1}');
        sessions.discard("k");
        await sessions.flushStorage();
        await sessions.acquire("k");
        assert.equal(runtimes.length, 2);
        assert.equal(runtimes[1].restored, '{"n":1}');
    } finally {
        sessions.dispose();
    }
});

test("the release of a call turn saves the storage of the runtime to the store", async () => {
    const clock = new FakeClock();
    const store = new MemoryStorageStore(10, 60_000, clock.now);
    const runtimes: FakeRuntime[] = [];
    const sessions = new SandboxSessions(
        new SandboxSettings(),
        async () => {
            const runtime = new FakeRuntime();
            runtimes.push(runtime);
            return runtime;
        },
        clock.now,
        store
    );
    try {
        await sessions.acquire("k");
        const release = await sessions.acquireTurn("k");
        runtimes[0].setStorage('{"after":"call"}');
        release();
        await sessions.flushStorage();
        assert.deepEqual(await store.load("k"), { kind: "value", text: '{"after":"call"}' });
    } finally {
        sessions.dispose();
    }
});

test(
    "two sessions on one Redis store share the saved storage of a key",
    { skip: REDIS_URI === undefined ? "PENPOT_MCP_TEST_REDIS_URI is unset" : false },
    async () => {
        const uri = REDIS_URI ?? "";
        const key = randomUUID();
        const storeA = new RedisStorageStore(uri, 60_000);
        const storeB = new RedisStorageStore(uri, 60_000);
        const runtimesA: FakeRuntime[] = [];
        const runtimesB: FakeRuntime[] = [];
        const sessionsA = new SandboxSessions(
            new SandboxSettings(),
            async () => {
                const runtime = new FakeRuntime();
                runtimesA.push(runtime);
                return runtime;
            },
            Date.now,
            storeA
        );
        const sessionsB = new SandboxSessions(
            new SandboxSettings(),
            async () => {
                const runtime = new FakeRuntime();
                runtimesB.push(runtime);
                return runtime;
            },
            Date.now,
            storeB
        );
        try {
            await storeA.whenReady();
            await storeB.whenReady();
            await sessionsA.acquire(key);
            runtimesA[0].setStorage('{"shared":true}');
            sessionsA.discard(key);
            await sessionsA.flushStorage();
            await sessionsB.acquire(key);
            assert.equal(runtimesB[0].restored, '{"shared":true}');
        } finally {
            sessionsA.dispose();
            sessionsB.dispose();
            await storeA.delete(key);
            await storeA.close();
            await storeB.close();
        }
    }
);

test(
    "a call with an unchanged storage refreshes the time to live of its saved copy",
    { skip: REDIS_SKIP },
    async () => {
        const uri = REDIS_URI ?? "";
        const key = tokenKey("ttl");
        const rawKey = `penpot.mcp.sandbox.storage.${key}`;
        const store = new RedisStorageStore(uri, 60_000);
        const raw = new Redis(uri);
        const sessions = new SandboxSessions(new SandboxSettings(), recordingFactory([]), Date.now, store);
        try {
            await store.whenReady();
            await runCall(sessions, key, (runtime) => runtime.setStorage('{"n":1}'));
            // age the copy as an idle token would, so that the next call shows whether its save refreshes it
            await raw.pexpire(rawKey, 1000);
            await runCall(sessions, key, () => undefined);
            const pttl = await raw.pttl(rawKey);
            assert.ok(pttl > 1000, `PTTL is ${pttl}, the unchanged copy was not refreshed`);
        } finally {
            sessions.dispose();
            await store.delete(key);
            await raw.quit();
            await store.close();
        }
    }
);

/** Store that records its saves and fails the next reads on request, for tests of a shared store. */
class FakeSharedStore implements StorageStore {
    public readonly shared = true;
    /** Texts held per key. */
    public readonly held = new Map<string, string>();
    /** Texts written, in order. */
    public readonly saves: Array<{ key: string; text: string }> = [];
    /** Number of the next reads that return unavailable. */
    public failingReads = 0;

    /**
     * Reads a key, failing while {@link failingReads} is positive.
     *
     * @param key - session key
     * @returns the held text, absent, or unavailable for a failing read
     */
    public async load(key: string): Promise<StorageLoad> {
        if (this.failingReads > 0) {
            this.failingReads -= 1;
            return { kind: "unavailable" };
        }
        const text = this.held.get(key);
        return text === undefined ? { kind: "absent" } : { kind: "value", text };
    }

    /**
     * Records and holds a text.
     *
     * @param key - session key
     * @param text - storage as JSON text
     * @returns true
     */
    public async save(key: string, text: string): Promise<boolean> {
        this.saves.push({ key, text });
        this.held.set(key, text);
        return true;
    }

    /**
     * Drops a key.
     *
     * @param key - session key
     */
    public async delete(key: string): Promise<void> {
        this.held.delete(key);
    }

    /** Nothing to clear: the test reads {@link held}. */
    public clear(): void {
        return;
    }

    /** Nothing to release. */
    public async close(): Promise<void> {
        return;
    }
}

/**
 * Creates a factory of fake runtimes that records each runtime it makes.
 *
 * @param made - list that receives every runtime
 * @returns the factory
 */
function recordingFactory(made: FakeRuntime[]): () => Promise<GuestRuntime> {
    return async () => {
        const runtime = new FakeRuntime();
        made.push(runtime);
        return runtime;
    };
}

/**
 * Runs one call the way the tool does: the turn, the acquisition, a change of the storage, and the awaited release.
 *
 * @param sessions - registry that serves the call
 * @param key - session key
 * @param change - changes the storage of the runtime during the call
 * @returns the runtime of the call
 */
async function runCall(
    sessions: SandboxSessions,
    key: string,
    change: (runtime: FakeRuntime) => void
): Promise<FakeRuntime> {
    const release = await sessions.acquireTurn(key);
    try {
        const runtime = (await sessions.acquire(key)) as FakeRuntime;
        change(runtime);
        return runtime;
    } finally {
        await release();
    }
}

/**
 * Derives a 64-hex session key from a name, as the tool derives it from a token.
 *
 * @param name - name of the tenant
 * @returns the SHA-256 hex digest of the name and a unique suffix
 */
function tokenKey(name: string): string {
    return createHash("sha256").update(`${name}:${randomUUID()}`, "utf8").digest("hex");
}

test("a shared store is read before each call, and a newer copy from another session is restored", async () => {
    const store = new FakeSharedStore();
    const made: FakeRuntime[] = [];
    const sessionsA = new SandboxSessions(new SandboxSettings(), recordingFactory(made), Date.now, store);
    const sessionsB = new SandboxSessions(new SandboxSettings(), recordingFactory(made), Date.now, store);
    try {
        await runCall(sessionsA, "k", () => undefined);
        await runCall(sessionsB, "k", (runtime) => runtime.setStorage('{"from":"b"}'));
        assert.equal(store.held.get("k"), '{"from":"b"}');
        const seen = await runCall(sessionsA, "k", () => undefined);
        assert.equal(seen.restored, '{"from":"b"}');
        assert.equal(seen.storageSnapshot, '{"from":"b"}');
        assert.equal(store.saves.length, 2, "an unchanged copy is saved again, which refreshes its time to live");
    } finally {
        sessionsA.dispose();
        sessionsB.dispose();
    }
});

test("an unreadable store skips the save of the call, reports a note, and saves again after a healthy read", async () => {
    const store = new FakeSharedStore();
    const made: FakeRuntime[] = [];
    const sessions = new SandboxSessions(new SandboxSettings(), recordingFactory(made), Date.now, store);
    try {
        store.failingReads = 1;
        await runCall(sessions, "k", (runtime) => runtime.setStorage('{"n":1}'));
        assert.deepEqual(store.saves, [], "the failed read leaves the save out");
        assert.equal(sessions.takeStorageNotice("k"), STORAGE_UNAVAILABLE_NOTICE);
        assert.equal(sessions.takeStorageNotice("k"), undefined, "the note is given once");

        await runCall(sessions, "k", (runtime) => runtime.setStorage('{"n":2}'));
        assert.deepEqual(store.saves, [{ key: "k", text: '{"n":2}' }]);
        assert.equal(sessions.takeStorageNotice("k"), undefined);
    } finally {
        sessions.dispose();
    }
});

test("shutdown saves the storage of every live runtime, skips an unreadable one, and disposes them", async () => {
    const store = new FakeSharedStore();
    const made: FakeRuntime[] = [];
    const sessions = new SandboxSessions(new SandboxSettings(), recordingFactory(made), Date.now, store);
    await runCall(sessions, "a", (runtime) => runtime.setStorage('{"key":"a"}'));
    await runCall(sessions, "b", (runtime) => runtime.setStorage('{"key":"b"}'));
    store.failingReads = 1;
    await runCall(sessions, "c", (runtime) => runtime.setStorage('{"key":"c"}'));
    await sessions.shutdown();
    assert.equal(store.held.get("a"), '{"key":"a"}');
    assert.equal(store.held.get("b"), '{"key":"b"}');
    assert.equal(store.held.has("c"), false, "a runtime whose storage was unreadable is not saved");
    assert.ok(made.every((runtime) => runtime.disposed));
    assert.equal(sessions.size, 0);
});

test("50 calls alternating between two adapters on one Redis count every call", { skip: REDIS_SKIP }, async () => {
    const uri = REDIS_URI ?? "";
    const key = tokenKey("alternating");
    const storeA = new RedisStorageStore(uri, 60_000);
    const storeB = new RedisStorageStore(uri, 60_000);
    const sessions = [
        new SandboxSessions(new SandboxSettings(), recordingFactory([]), Date.now, storeA),
        new SandboxSessions(new SandboxSettings(), recordingFactory([]), Date.now, storeB),
    ];
    try {
        await storeA.whenReady();
        await storeB.whenReady();
        for (let i = 0; i < 50; i += 1) {
            await runCall(sessions[i % 2], key, (runtime) => {
                const previous =
                    runtime.storageSnapshot === undefined
                        ? 0
                        : (JSON.parse(runtime.storageSnapshot) as { n: number }).n;
                runtime.setStorage(JSON.stringify({ n: previous + 1 }));
            });
        }
        assert.deepEqual(await storeA.load(key), { kind: "value", text: '{"n":50}' });
    } finally {
        sessions[0].dispose();
        sessions[1].dispose();
        await storeA.delete(key);
        await storeA.close();
        await storeB.close();
    }
});

test("two adapters on one Redis keep the storage of two tokens apart", { skip: REDIS_SKIP }, async () => {
    const uri = REDIS_URI ?? "";
    const keyA = tokenKey("tenant-a");
    const keyB = tokenKey("tenant-b");
    const storeA = new RedisStorageStore(uri, 60_000);
    const storeB = new RedisStorageStore(uri, 60_000);
    const loadedByB: string[] = [];
    const loadOfB = storeB.load.bind(storeB);
    storeB.load = async (key: string): Promise<StorageLoad> => {
        loadedByB.push(key);
        return loadOfB(key);
    };
    const sessionsA = new SandboxSessions(new SandboxSettings(), recordingFactory([]), Date.now, storeA);
    const madeB: FakeRuntime[] = [];
    const sessionsB = new SandboxSessions(new SandboxSettings(), recordingFactory(madeB), Date.now, storeB);
    try {
        await storeA.whenReady();
        await storeB.whenReady();
        await runCall(sessionsA, keyA, (runtime) => runtime.setStorage('{"owner":"a"}'));
        const seenByB = await runCall(sessionsB, keyB, () => undefined);
        assert.equal(seenByB.restored, undefined, "token B's runtime gets no storage of token A");
        assert.equal(seenByB.storageSnapshot, undefined);
        assert.deepEqual(loadedByB, [keyB], "a call under token B never reads the key of token A");
        assert.deepEqual(await storeA.load(keyA), { kind: "value", text: '{"owner":"a"}' });
        assert.equal(madeB.length, 1);
    } finally {
        sessionsA.dispose();
        sessionsB.dispose();
        await storeA.delete(keyA);
        await storeA.delete(keyB);
        await storeA.close();
        await storeB.close();
    }
});
