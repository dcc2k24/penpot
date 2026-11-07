import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxRuntime, SandboxRuntimeError, type SandboxHostCalls } from "./SandboxRuntime";
import { SandboxSessions } from "./SandboxSessions";
import { SandboxSettings } from "./SandboxSettings";

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
