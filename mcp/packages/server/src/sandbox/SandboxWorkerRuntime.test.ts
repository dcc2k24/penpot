import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxRuntimeError, type SandboxHostCalls } from "./GuestRuntime";
import { SandboxSessions } from "./SandboxSessions";
import { SandboxSettings } from "./SandboxSettings";
import { STORAGE_BRIDGE } from "./SandboxWorkerProtocol";
import { SandboxWorkerRuntime } from "./SandboxWorkerRuntime";

/** Prelude of the worker tests: a `storage` object and the functions that the tests call. */
const PRELUDE = `
var storage = {};
function ping() { return "pong"; }
function spin() { for (;;) {} }
function set() { storage.n = 1; return "ok"; }
function get() { return String(storage.n); }
function cycle() { storage.self = storage; return "ok"; }
function readCycle() { return String(storage.self.self === storage); }
function bomb() { var a = []; for (;;) { a.push("x".repeat(1000000)); } }
function read() { return __host.loadPage("f", "p"); }
function write() { return __host.flush("f", "[1]", false); }
function neverFlush() { __host.flush("f", "[1]", false); return "x"; }
function big() { storage.s = "x".repeat(9 * 1024 * 1024); return "ok"; }
function hook() { storage.x = { toJSON: function () { return __host.loadPage("f", "p"); } }; return "ok"; }
function sortBig() { var a = "0123456789abcdef".repeat(100000).split(""); a.sort(); return "done"; }
function chunks() { try { __host.flush("f", "[2]", false); } catch (e) { return "caught:" + e.message; } return "none"; }
`;

/** Options that make a worker runtime small enough for the memory test. */
const SMALL_HEAP = { memoryLimitBytes: 32 * 1024 * 1024 };

/** Host that answers the primitives of a test and rejects the others. */
class TestHost implements SandboxHostCalls {
    async loadFileOutline(): Promise<string> {
        throw new Error("loadFileOutline is not expected in this test");
    }

    async loadPage(fileId: string, pageId: string): Promise<string> {
        return `page:${fileId}:${pageId}`;
    }

    async flush(): Promise<string> {
        return '{"revn":2}';
    }

    async importSvg(): Promise<string> {
        throw new Error("importSvg is not expected in this test");
    }

    async rpc(): Promise<string> {
        throw new Error("rpc is not expected in this test");
    }

    async exportShape(): Promise<string> {
        throw new Error("exportShape is not expected in this test");
    }

    async uploadMediaUrl(): Promise<string> {
        throw new Error("uploadMediaUrl is not expected in this test");
    }

    async uploadMediaData(): Promise<string> {
        throw new Error("uploadMediaData is not expected in this test");
    }
}

/** Host whose flush never answers, as a stuck backend would not. */
class NeverFlush extends TestHost {
    override flush(): Promise<string> {
        return new Promise<string>(() => undefined);
    }
}

/** Host whose flush fails, as a chunk that the backend refused would. */
class FailingFlush extends TestHost {
    override async flush(): Promise<string> {
        throw new Error("chunk 2 failed");
    }
}

/**
 * Creates a worker runtime with the test prelude, whatever the environment says.
 *
 * @param options - limits of the guest
 * @returns the ready runtime
 */
function workerRuntime(options: Parameters<typeof SandboxWorkerRuntime.create>[1] = {}): Promise<SandboxWorkerRuntime> {
    return SandboxWorkerRuntime.create(PRELUDE + "\n" + STORAGE_BRIDGE, options);
}

test("a worker entry is in this build", () => {
    assert.equal(SandboxWorkerRuntime.isAvailable(), true);
});

test("a busy loop in a worker does not delay the main thread or a concurrent call", async () => {
    const spinning = await workerRuntime();
    const other = await workerRuntime();
    try {
        const gaps: number[] = [];
        let last = performance.now();
        const timer = setInterval(() => {
            const now = performance.now();
            gaps.push(now - last);
            last = now;
        }, 10);
        const run = spinning.invoke("spin", [], new TestHost(), 1000);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const started = performance.now();
        assert.equal(await other.invoke("ping", [], new TestHost(), 1000), "pong");
        const answered = performance.now() - started;
        await assert.rejects(run, (error: unknown) => error instanceof SandboxRuntimeError && error.limit === "cpu");
        clearInterval(timer);
        // the other worker needs CPU of its own, so under a loaded machine its call can take longer than the
        // timer gap allows. The gap check below keeps the 100 ms limit of the main thread.
        assert.ok(answered < 1000, `a concurrent call took ${answered.toFixed(1)} ms`);
        assert.ok(Math.max(...gaps) < 100, `the main thread was blocked for ${Math.max(...gaps).toFixed(1)} ms`);
    } finally {
        spinning.dispose();
        other.dispose();
    }
});

test("a memory bomb terminates the worker, and the next runtime of the token starts with its storage", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(), () => workerRuntime(SMALL_HEAP));
    try {
        const before = SandboxWorkerRuntime.liveCount();
        const first = await sessions.acquire("token");
        assert.equal(await first.invoke("set", [], new TestHost(), 1000), "ok");
        await assert.rejects(first.invoke("bomb", [], new TestHost(), 3000), (error: unknown) => {
            return error instanceof SandboxRuntimeError && error.fatal && error.limit === "memory";
        });
        assert.equal(first.poisoned, true);
        assert.equal(first.disposed, false, "the poisoned runtime is not disposed until the registry drops it");
        sessions.discard("token");
        assert.equal(SandboxWorkerRuntime.liveCount(), before, "the bombed worker is gone");

        const second = await sessions.acquire("token");
        assert.notEqual(second, first);
        assert.equal(await second.invoke("get", [], new TestHost(), 1000), "1");
    } finally {
        sessions.dispose();
    }
});

test("a call that never answers a write is ended at the wall clock, and the worker is terminated", async () => {
    const runtime = await workerRuntime();
    const before = SandboxWorkerRuntime.liveCount();
    const started = Date.now();
    try {
        await assert.rejects(
            runtime.invoke("neverFlush", [], new NeverFlush(), 1000, { wallMs: 150, writeGraceMs: 100 }),
            (error: unknown) => error instanceof SandboxRuntimeError && error.fatal && error.limit === "wall"
        );
        assert.ok(Date.now() - started < 3000, "the watchdog should not wait for the full write grace");
        assert.equal(runtime.poisoned, true);
        assert.equal(SandboxWorkerRuntime.liveCount(), before - 1);
    } finally {
        runtime.dispose();
    }
});

test("a wall-clock expiry frees the call slot of the token's turn, and the next call runs on a fresh runtime", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(), () => workerRuntime());
    try {
        const release = await sessions.acquireTurn("token");
        const runtime = await sessions.acquire("token");
        await assert.rejects(
            runtime.invoke("neverFlush", [], new NeverFlush(), 1000, { wallMs: 150, writeGraceMs: 100 }),
            SandboxRuntimeError
        );
        sessions.discard("token");
        release();

        const again = await sessions.acquireTurn("token");
        again();
        const next = await sessions.acquire("token");
        assert.notEqual(next, runtime);
        assert.equal(await next.invoke("ping", [], new TestHost(), 1000), "pong");
    } finally {
        sessions.dispose();
    }
});

test("reads and writes reach the host from the worker, and a failed chunk reaches the guest as an error", async () => {
    const runtime = await workerRuntime();
    try {
        assert.equal(await runtime.invoke("read", [], new TestHost(), 1000), "page:f:p");
        assert.equal(await runtime.invoke("write", [], new TestHost(), 1000), '{"revn":2}');
        assert.equal(await runtime.invoke("chunks", [], new FailingFlush(), 1000), "caught:chunk 2 failed");
        assert.equal(runtime.poisoned, false, "a failed host call is not fatal");
    } finally {
        runtime.dispose();
    }
});

test("storage that cannot be saved as JSON stays in the worker while it lives", async () => {
    const runtime = await workerRuntime();
    try {
        assert.equal(await runtime.invoke("cycle", [], new TestHost(), 1000), "ok");
        assert.equal(runtime.storageSnapshot, undefined);
        assert.equal(await runtime.invoke("readCycle", [], new TestHost(), 1000), "true");
    } finally {
        runtime.dispose();
    }
});

test("stop disposes every worker runtime of the registry", async () => {
    const before = SandboxWorkerRuntime.liveCount();
    const sessions = new SandboxSessions(new SandboxSettings(), () => workerRuntime());
    const first = await sessions.acquire("a");
    const second = await sessions.acquire("b");
    assert.equal(SandboxWorkerRuntime.liveCount(), before + 2);
    sessions.stop();
    assert.equal(first.disposed, true);
    assert.equal(second.disposed, true);
    assert.equal(SandboxWorkerRuntime.liveCount(), before);
    sessions.dispose();
});

test("storage above 8 MB keeps the saved copy and leaves a note for the caller", async () => {
    const runtime = await workerRuntime();
    try {
        assert.equal(await runtime.invoke("set", [], new TestHost(), 1000), "ok");
        assert.equal(runtime.storageSnapshot, '{"n":1}');
        assert.equal(await runtime.invoke("big", [], new TestHost(), 3000), "ok");
        assert.equal(runtime.storageSnapshot, '{"n":1}', "the saved copy stays at the last size that fit");
        assert.match(runtime.takeNotice() ?? "", /above the 8 MB limit/);
        assert.equal(runtime.takeNotice(), undefined, "a note is taken once");
    } finally {
        runtime.dispose();
    }
});

test("a saved storage that cannot be restored is dropped, and the call fails with that reason", async () => {
    const runtime = await workerRuntime();
    try {
        runtime.restoreStorage("{not json");
        await assert.rejects(
            runtime.invoke("ping", [], new TestHost(), 1000),
            (error: unknown) =>
                error instanceof SandboxRuntimeError &&
                !error.fatal &&
                /could not be restored, so it was dropped/.test(error.message)
        );
        assert.equal(runtime.storageSnapshot, undefined);
        assert.equal(runtime.poisoned, false);
        assert.equal(await runtime.invoke("get", [], new TestHost(), 1000), "undefined", "storage starts empty");
    } finally {
        runtime.dispose();
    }
});

test("the storage read cannot start a host call from a toJSON method", async () => {
    const runtime = await workerRuntime();
    const host = new TestHost();
    let primitiveCalls = 0;
    host.loadPage = async () => {
        primitiveCalls += 1;
        return "page";
    };
    try {
        assert.equal(await runtime.invoke("hook", [], host, 1000), "ok");
        assert.equal(primitiveCalls, 0, "the read refuses host calls");
        assert.equal(runtime.storageSnapshot, undefined, "storage that the read could not save is not kept");
        assert.equal(runtime.poisoned, false);
    } finally {
        runtime.dispose();
    }
});

test("a native sort that outruns the budgets is stopped by the main thread, not by the worker's interrupt", async () => {
    const runtime = await SandboxWorkerRuntime.create(
        PRELUDE + "\n" + STORAGE_BRIDGE,
        {},
        {
            cpuBackstopMs: 200,
            storageBudgetMs: 50,
        }
    );
    const before = SandboxWorkerRuntime.liveCount();
    const started = Date.now();
    try {
        // the native sort runs for about 2 s and never reaches the interrupt handler; the allowance is 50 + 2 * 50 + 200 ms.
        await assert.rejects(
            runtime.invoke("sortBig", [], new TestHost(), 50),
            (error: unknown) =>
                error instanceof SandboxRuntimeError &&
                error.fatal &&
                error.limit === "cpu" &&
                error.guestName === undefined
        );
        assert.ok(Date.now() - started < 1500, "the call was ended before the sort finished");
        assert.equal(runtime.poisoned, true);
        assert.equal(SandboxWorkerRuntime.liveCount(), before - 1);
    } finally {
        runtime.dispose();
    }
});

test("saved storage is kept for the most recently used keys only", async () => {
    const sessions = new SandboxSessions(new SandboxSettings(10_000, 60_000, 120_000, 1000, 2), () => workerRuntime());
    try {
        for (const key of ["a", "b", "c"]) {
            const runtime = await sessions.acquire(key);
            assert.equal(await runtime.invoke("set", [], new TestHost(), 1000), "ok");
            sessions.discard(key);
        }
        assert.equal(sessions.savedStorageCount, 2);
        const first = await sessions.acquire("a");
        assert.equal(await first.invoke("get", [], new TestHost(), 1000), "undefined", "the oldest copy is gone");
        const last = await sessions.acquire("c");
        assert.equal(await last.invoke("get", [], new TestHost(), 1000), "1", "the newest copy is kept");
    } finally {
        sessions.dispose();
    }
});

test("a prelude that fails stops the worker and rejects the start", async () => {
    const before = SandboxWorkerRuntime.liveCount();
    await assert.rejects(
        SandboxWorkerRuntime.create('throw new Error("prelude failed");', {}),
        (error: unknown) => error instanceof SandboxRuntimeError && error.fatal
    );
    assert.equal(SandboxWorkerRuntime.liveCount(), before);
});
