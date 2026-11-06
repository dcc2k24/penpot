import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxRuntime, SandboxRuntimeError, type SandboxHostCalls } from "./SandboxRuntime";

/** Host that answers the primitives that a test needs and rejects the others. */
class TestHost implements SandboxHostCalls {
    /** Delay of loadPage, in milliseconds. */
    public pageDelayMs = 0;
    /** Message of the error thrown by rpc. */
    public rpcErrorMessage = "rpc failed on purpose";

    async loadFileOutline(): Promise<string> {
        throw new Error("loadFileOutline is not expected in this test");
    }

    async loadPage(fileId: string, pageId: string): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, this.pageDelayMs));
        return `page:${fileId}:${pageId}`;
    }

    async flush(): Promise<string> {
        throw new Error("flush is not expected in this test");
    }

    async importSvg(): Promise<string> {
        throw new Error("importSvg is not expected in this test");
    }

    async rpc(): Promise<string> {
        throw new Error(this.rpcErrorMessage);
    }

    async exportShape(paramsJson: string): Promise<string> {
        return `export:${paramsJson}`;
    }

    async uploadMediaUrl(paramsJson: string): Promise<string> {
        return `media-url:${paramsJson}`;
    }

    async uploadMediaData(paramsJson: string): Promise<string> {
        return `media-data:${paramsJson}`;
    }
}

/**
 * Returns the median of a list of numbers.
 *
 * @param values - numbers to take the median of, which must not be empty
 */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

test("start-up time and per-call overhead", async () => {
    const startUps: number[] = [];
    for (let index = 0; index < 5; index++) {
        const started = performance.now();
        const runtime = await SandboxRuntime.create("");
        startUps.push(performance.now() - started);
        runtime.dispose();
    }
    const startUpMedian = median(startUps);
    for (const elapsed of startUps) {
        assert.ok(elapsed < 1000, `start-up took ${elapsed} ms`);
    }
    console.log("sandbox start-up ms", startUpMedian.toFixed(2));

    const runtime = await SandboxRuntime.create('function run() { return "ok" }');
    try {
        const calls = 200;
        const started = performance.now();
        for (let index = 0; index < calls; index++) {
            await runtime.invoke("run", [], new TestHost(), 1000);
        }
        const perCall = (performance.now() - started) / calls;
        console.log("sandbox invoke overhead ms per call", perCall.toFixed(3));
    } finally {
        runtime.dispose();
    }
});

test("a simple function returns its string", async () => {
    const runtime = await SandboxRuntime.create('function run() { return "ok" }');
    try {
        assert.equal(await runtime.invoke("run", [], new TestHost(), 1000), "ok");
    } finally {
        runtime.dispose();
    }
});

test("arguments reach the guest as strings", async () => {
    const runtime = await SandboxRuntime.create('function echo(a, b) { return a + "|" + b }');
    try {
        const result = await runtime.invoke("echo", ["quote \"'` ${x}", "second"], new TestHost(), 1000);
        assert.equal(result, "quote \"'` ${x}|second");
    } finally {
        runtime.dispose();
    }
});

test("a busy loop exceeds the CPU budget and poisons the runtime", async () => {
    const runtime = await SandboxRuntime.create("function run() { while (true) {} }");
    const started = Date.now();
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 300), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.fatal, true);
            assert.ok(error.message.includes("CPU limit"), error.message);
            return true;
        });
        assert.ok(Date.now() - started < 3000);
        assert.equal(runtime.poisoned, true);
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 300), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.message, "runtime was discarded");
            return true;
        });
    } finally {
        runtime.dispose();
    }
});

test("a memory bomb exceeds the memory limit", async () => {
    const runtime = await SandboxRuntime.create(
        'function run() { const a = []; while (true) { a.push("x".repeat(100)) } }',
        { memoryLimitBytes: 8 * 1024 * 1024 }
    );
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 10_000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.fatal, true);
            assert.ok(error.message.includes("memory limit"), error.message);
            return true;
        });
    } finally {
        runtime.dispose();
    }
});

test("a memory bomb of large arrays stops at the WebAssembly memory limit and leaves the runtime spent", async () => {
    const memoryLimitBytes = 32 * 1024 * 1024;
    const runtime = await SandboxRuntime.create(
        "function run() { const hoard = []; try { while (true) { hoard.push(new Array(1000000).fill(7)); } }" +
            ' catch (e) { return String(e); } } function ok() { return "ok"; }',
        { memoryLimitBytes }
    );
    try {
        assert.equal(runtime.spent, false);
        const result = await runtime.invoke("run", [], new TestHost(), 10_000);
        assert.ok(result.includes("out of memory"), result);
        assert.ok(runtime.wasmMemoryBytes <= 2 * memoryLimitBytes, `wasm memory ${runtime.wasmMemoryBytes}`);
        assert.equal(runtime.spent, true);
        assert.equal(await runtime.invoke("ok", [], new TestHost(), 1000), "ok");
    } finally {
        runtime.dispose();
    }
    assert.equal(runtime.spent, false);
});

test("a normal script does not leave the runtime spent", async () => {
    const runtime = await SandboxRuntime.create('function run() { return "x".repeat(1000); }');
    try {
        await runtime.invoke("run", [], new TestHost(), 1000);
        assert.equal(runtime.spent, false);
    } finally {
        runtime.dispose();
    }
});

test("unbounded recursion is caught inside the guest", async () => {
    const runtime = await SandboxRuntime.create(
        "function f() { return f() + 1 }\n" + 'function run() { try { f() } catch (e) { return "caught" } }'
    );
    try {
        assert.equal(await runtime.invoke("run", [], new TestHost(), 5000), "caught");
        assert.equal(runtime.poisoned, false);
    } finally {
        runtime.dispose();
    }
});

test("host time is not charged to the CPU budget", async () => {
    const host = new TestHost();
    host.pageDelayMs = 400;
    const runtime = await SandboxRuntime.create('function run() { return __host.loadPage("f", "p") }');
    try {
        assert.equal(await runtime.invoke("run", [], host, 300), "page:f:p");
    } finally {
        runtime.dispose();
    }

    const spinning = await SandboxRuntime.create(
        'function spin() { const s = Date.now(); while (Date.now() - s < 500) {} return "spun" }'
    );
    try {
        await assert.rejects(spinning.invoke("spin", [], new TestHost(), 300), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.ok(error.message.includes("CPU limit"), error.message);
            return true;
        });
    } finally {
        spinning.dispose();
    }
});

test("a host error reaches the guest as a catchable Error", async () => {
    const runtime = await SandboxRuntime.create(
        'function run() { try { __host.rpc("x", "{}") } catch (e) { return "caught:" + e.message } }'
    );
    try {
        assert.equal(await runtime.invoke("run", [], new TestHost(), 1000), "caught:rpc failed on purpose");
    } finally {
        runtime.dispose();
    }
});

test("an uncaught host error arrives as a non-fatal runtime error", async () => {
    const runtime = await SandboxRuntime.create('function run() { return __host.rpc("x", "{}") }');
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.message, "rpc failed on purpose");
            assert.equal(error.fatal, false);
            return true;
        });
        assert.equal(runtime.poisoned, false);
    } finally {
        runtime.dispose();
    }
});

test("calls started without awaiting run in FIFO order", async () => {
    const host = new TestHost();
    host.pageDelayMs = 50;
    const runtime = await SandboxRuntime.create(
        'function first() { return __host.loadPage("a", "b") }\n' + 'function second(x) { return "second:" + x }'
    );
    try {
        const firstCall = runtime.invoke("first", [], host, 1000);
        const secondCall = runtime.invoke("second", ["now"], host, 1000);
        assert.deepEqual(await Promise.all([firstCall, secondCall]), ["page:a:b", "second:now"]);
    } finally {
        runtime.dispose();
    }
});

test("non-string results are rejected", async () => {
    const runtime = await SandboxRuntime.create(
        "function run() { return 42 }\nfunction promised() { return Promise.resolve(7) }"
    );
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), SandboxRuntimeError);
        await assert.rejects(runtime.invoke("promised", [], new TestHost(), 1000), SandboxRuntimeError);
        assert.equal(runtime.poisoned, false);
    } finally {
        runtime.dispose();
    }
});

test("a promise that never settles is reported", async () => {
    const runtime = await SandboxRuntime.create("function run() { return new Promise(() => {}) }");
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            return true;
        });
    } finally {
        runtime.dispose();
    }
});

test("a promise that rejects in the guest is reported as an error", async () => {
    const runtime = await SandboxRuntime.create('async function run() { throw new TypeError("async failure") }');
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.guestName, "TypeError");
            assert.equal(error.message, "async failure");
            return true;
        });
    } finally {
        runtime.dispose();
    }
});

test("a host primitive called after an await is refused without corrupting the runtime", async () => {
    const runtime = await SandboxRuntime.create(
        'async function run() { await null; return __host.rpc("x", "{}") }\n' +
            'async function plain() { await null; return "p" }'
    );
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.message, "host primitives cannot be called after an await");
            assert.equal(error.fatal, false);
            return true;
        });
        assert.equal(runtime.poisoned, false);
        assert.equal(await runtime.invoke("plain", [], new TestHost(), 1000), "p");
    } finally {
        runtime.dispose();
    }
});

test("a guest failure is reported with the guest error name", async () => {
    const runtime = await SandboxRuntime.create("function run() { return missing() }");
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.guestName, "ReferenceError");
            assert.equal(error.fatal, false);
            return true;
        });
    } finally {
        runtime.dispose();
    }
});

test("lifecycle: 100 create, invoke and dispose cycles leave no live runtime", async () => {
    const started = Date.now();
    for (let cycle = 0; cycle < 100; cycle++) {
        const runtime = await SandboxRuntime.create('function run() { return "ok" }');
        assert.equal(await runtime.invoke("run", [], new TestHost(), 1000), "ok");
        runtime.dispose();
    }
    console.log("sandbox 100 lifecycle cycles ms", Date.now() - started);
    assert.equal(SandboxRuntime.liveCount(), 0);
});

test("dispose is idempotent and marks the runtime as disposed", async () => {
    const runtime = await SandboxRuntime.create("");
    assert.equal(SandboxRuntime.liveCount() > 0, true);
    runtime.dispose();
    runtime.dispose();
    assert.equal(runtime.disposed, true);
    await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), SandboxRuntimeError);
});

test("calls queued behind a dispose are refused", async () => {
    const runtime = await SandboxRuntime.create('function run() { return "ok" }');
    const queued = runtime.invoke("run", [], new TestHost(), 1000);
    runtime.dispose();
    await assert.rejects(
        queued,
        (error: unknown) => error instanceof SandboxRuntimeError && error.message === "runtime was discarded"
    );
    await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), SandboxRuntimeError);
});

test("the export and media primitives reach the host and return its text", async () => {
    const source = `function run() {
        return __host.exportShape('{"a":1}') + "|" + __host.uploadMediaUrl("u") + "|" + __host.uploadMediaData("d");
    }`;
    const loaded = await SandboxRuntime.create(source);
    assert.equal(await loaded.invoke("run", [], new TestHost(), 1000), 'export:{"a":1}|media-url:u|media-data:d');
    loaded.dispose();
});

/** Host whose loadPage never settles. */
class HangingHost extends TestHost {
    loadPage(): Promise<string> {
        return new Promise<string>(() => {});
    }
}

test("a busy loop stops at the wall-clock deadline and poisons the runtime", async () => {
    const runtime = await SandboxRuntime.create("function run() { while (true) {} }");
    const started = Date.now();
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 60_000, Date.now() + 100), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.fatal, true);
            assert.ok(error.message.includes("wall-clock"), error.message);
            return true;
        });
        assert.ok(Date.now() - started < 5000);
        assert.equal(runtime.poisoned, true);
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 60_000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.message, "runtime was discarded");
            return true;
        });
    } finally {
        runtime.dispose();
    }
});

test("a host call that never settles stops at the wall-clock deadline", async () => {
    const runtime = await SandboxRuntime.create('function run() { return __host.loadPage("f", "p") }');
    const started = Date.now();
    try {
        await assert.rejects(
            runtime.invoke("run", [], new HangingHost(), 60_000, Date.now() + 50),
            (error: unknown) => {
                assert.ok(error instanceof SandboxRuntimeError);
                assert.equal(error.fatal, true);
                assert.ok(error.message.includes("wall-clock"), error.message);
                return true;
            }
        );
        assert.ok(Date.now() - started < 5000);
        assert.equal(runtime.poisoned, true);
    } finally {
        runtime.dispose();
    }
});

test("a guest that catches the wall-clock error is still stopped", async () => {
    const runtime = await SandboxRuntime.create(
        'function run() { try { __host.loadPage("f", "p") } catch (e) { return "caught" } }'
    );
    try {
        await assert.rejects(
            runtime.invoke("run", [], new HangingHost(), 60_000, Date.now() + 50),
            (error: unknown) => {
                assert.ok(error instanceof SandboxRuntimeError);
                assert.equal(error.fatal, true);
                assert.ok(error.message.includes("wall-clock"), error.message);
                return true;
            }
        );
        assert.equal(runtime.poisoned, true);
    } finally {
        runtime.dispose();
    }
});

test("without a deadline a slow host call completes, and a far deadline does not stop it", async () => {
    const host = new TestHost();
    host.pageDelayMs = 150;
    const runtime = await SandboxRuntime.create('function run() { return __host.loadPage("f", "p") }');
    try {
        assert.equal(await runtime.invoke("run", [], host, 1000), "page:f:p");
        assert.equal(await runtime.invoke("run", [], host, 1000, Date.now() + 60_000), "page:f:p");
        assert.equal(runtime.poisoned, false);
    } finally {
        runtime.dispose();
    }
});
