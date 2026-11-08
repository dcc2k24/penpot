import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuestRuntime } from "./GuestRuntime";
import { SandboxRuntime, SandboxRuntimeError, type SandboxHostCalls } from "./SandboxRuntime";

/**
 * Creates a runtime, and retries once when the worker was lost while it started.
 *
 * A worker start takes about half a second and can be slowed a lot by a loaded machine. A loss during the start is
 * retried once; a second loss, and every other failure, is raised.
 *
 * @param prelude - guest source of the runtime
 * @returns the ready runtime
 */
async function createRetryingLoss(prelude: string): Promise<GuestRuntime> {
    try {
        return await SandboxRuntime.create(prelude);
    } catch (error) {
        if (
            error instanceof SandboxRuntimeError &&
            /^The sandbox worker (stopped unexpectedly|failed: )/.test(error.message)
        ) {
            return SandboxRuntime.create(prelude);
        }
        throw error;
    }
}

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
    // a worker starts in about half a second, and test files run in parallel, so the bound only catches a hang.
    for (const elapsed of startUps) {
        assert.ok(elapsed < 10_000, `start-up took ${elapsed} ms`);
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

test("a promise returned by the guest is not read as a result", async () => {
    const runtime = await SandboxRuntime.create("function run() { return new Promise(() => {}) }");
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.message, "The script must return a string.");
            return true;
        });
    } finally {
        runtime.dispose();
    }
});

test("an async function's rejection is not read as a result", async () => {
    const runtime = await SandboxRuntime.create('async function run() { throw new TypeError("async failure") }');
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.message, "The script must return a string.");
            return true;
        });
    } finally {
        runtime.dispose();
    }
});

test("a script that replaces Promise.prototype.then cannot hang a call", async () => {
    const runtime = await SandboxRuntime.create(
        'function run() { Promise.prototype.then = function () {}; return "done" }\n' +
            'function plain() { return "p" }'
    );
    try {
        assert.equal(await runtime.invoke("run", [], new TestHost(), 1000, { wallMs: 5000 }), "done");
        assert.equal(await runtime.invoke("plain", [], new TestHost(), 1000, { wallMs: 5000 }), "p");
    } finally {
        runtime.dispose();
    }
});

test("the arguments of a call are literals, so a setter on __arg0 cannot hang the next call", async () => {
    const runtime = await SandboxRuntime.create(
        "function define() {\n" +
            '  Object.defineProperty(globalThis, "__arg0", { configurable: true, get() { return "" }, set() { for (;;) {} } });\n' +
            '  return "defined";\n' +
            "}\n" +
            "function echo(text) { return text }"
    );
    try {
        assert.equal(await runtime.invoke("define", [], new TestHost(), 1000, { wallMs: 5000 }), "defined");
        assert.equal(
            await runtime.invoke("echo", ["quote \"'` ${x}"], new TestHost(), 1000, { wallMs: 5000 }),
            "quote \"'` ${x}"
        );
    } finally {
        runtime.dispose();
    }
});

test("the interrupt handler stops guest code that runs outside a call", async () => {
    // reads a private method of the in-process runtime, so the runtime is created on this thread.
    const runtime = await SandboxRuntime.createInProcess("");
    try {
        const internals = runtime as unknown as { shouldInterrupt(): boolean };
        assert.equal(internals.shouldInterrupt(), true);
    } finally {
        runtime.dispose();
    }
});

test("a write that never answers is ended by the watchdog, and the runtime is marked dead", async () => {
    class HangingWriteHost extends TestHost {
        override flush(): Promise<string> {
            return new Promise<string>(() => {});
        }
    }
    const runtime = await SandboxRuntime.create('function run() { __host.flush("f", "[]", false); return "x" }');
    try {
        await assert.rejects(
            runtime.invoke("run", [], new HangingWriteHost(), 1000, { wallMs: 100, writeGraceMs: 200 }),
            (error: unknown) => {
                assert.ok(error instanceof SandboxRuntimeError);
                assert.equal(error.fatal, true);
                assert.equal(error.limit, "wall");
                return true;
            }
        );
        assert.equal(runtime.poisoned, true);
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.message, "runtime was discarded");
            return true;
        });
    } finally {
        runtime.dispose();
    }
});

test("a write in flight at the deadline is waited for, and the script stops after it", async () => {
    class SlowWriteHost extends TestHost {
        public flushes = 0;
        override async flush(): Promise<string> {
            await new Promise((resolve) => setTimeout(resolve, 300));
            this.flushes += 1;
            return '{"revn":5}';
        }
    }
    const host = new SlowWriteHost();
    const runtime = await SandboxRuntime.create(
        'function run() { var answer = __host.flush("f", "[]", false); return "after:" + answer }'
    );
    try {
        await assert.rejects(runtime.invoke("run", [], host, 1000, { wallMs: 100 }), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.limit, "wall");
            return true;
        });
        assert.equal(host.flushes, 1);
    } finally {
        runtime.dispose();
    }
});

test("the wall clock of a call starts when the call starts, not when it is queued", async () => {
    const runtime = await SandboxRuntime.create(
        'function slow() { var t = Date.now(); while (Date.now() - t < 300) {} return "s" }\n' +
            'function run() { return "r" }'
    );
    try {
        const first = runtime.invoke("slow", [], new TestHost(), 1000, { wallMs: 5000 });
        let remaining = -1;
        const second = runtime.invoke("run", [], new TestHost(), 1000, {
            wallMs: 1000,
            onStart: (deadlineAt) => {
                remaining = deadlineAt - Date.now();
            },
        });
        assert.equal(await first, "s");
        assert.equal(await second, "r");
        assert.ok(remaining >= 900, `the clock had ${remaining} ms left when the call started`);
    } finally {
        runtime.dispose();
    }
});

test("a global that a script replaces is read-only for the next call", async () => {
    const runtime = await SandboxRuntime.create(
        'var __runScript = function () { return "original" };\n' +
            'function tamper() { __runScript = function () { return "changed" }; return "tampered" }\n' +
            "function call() { return __runScript() }"
    );
    try {
        assert.equal(await runtime.invoke("tamper", [], new TestHost(), 1000, { wallMs: 5000 }), "tampered");
        assert.equal(await runtime.invoke("call", [], new TestHost(), 1000, { wallMs: 5000 }), "original");
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
        const runtime = await createRetryingLoss('function run() { return "ok" }');
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
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 60_000, { wallMs: 100 }), (error: unknown) => {
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
        await assert.rejects(runtime.invoke("run", [], new HangingHost(), 60_000, { wallMs: 50 }), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.fatal, true);
            assert.ok(error.message.includes("wall-clock"), error.message);
            return true;
        });
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
        await assert.rejects(runtime.invoke("run", [], new HangingHost(), 60_000, { wallMs: 50 }), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.equal(error.fatal, true);
            assert.ok(error.message.includes("wall-clock"), error.message);
            return true;
        });
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
        assert.equal(await runtime.invoke("run", [], host, 1000, { wallMs: 60_000 }), "page:f:p");
        assert.equal(runtime.poisoned, false);
    } finally {
        runtime.dispose();
    }
});

test("a write that outlives the grace is waited for while its write allowance lasts", async () => {
    class SlowFlush extends TestHost {
        public flushes = 0;
        override async flush(): Promise<string> {
            await new Promise((resolve) => setTimeout(resolve, 400));
            this.flushes += 1;
            return '{"revn":5}';
        }
    }
    const host = new SlowFlush();
    const runtime = await SandboxRuntime.create('function run() { __host.flush("f", "[]", false); return "x" }');
    try {
        await assert.rejects(
            runtime.invoke("run", [], host, 1000, { wallMs: 100, writeGraceMs: 50, writeAllowanceMs: () => 5000 }),
            (error: unknown) => {
                assert.ok(error instanceof SandboxRuntimeError);
                assert.equal(error.limit, "wall");
                return true;
            }
        );
        assert.equal(host.flushes, 1, "the write finished before the call was reported");
    } finally {
        runtime.dispose();
    }
});

test("a stuck runtime frees its context once the host call it waited for settles", async () => {
    class LateFlush extends TestHost {
        override async flush(): Promise<string> {
            await new Promise((resolve) => setTimeout(resolve, 300));
            return '{"revn":5}';
        }
    }
    // reads a private flag of the in-process runtime, so the runtime is created on this thread.
    const runtime = await SandboxRuntime.createInProcess(
        'function run() { __host.flush("f", "[]", false); return "x" }'
    );
    const internals = runtime as unknown as { contextReleased: boolean };
    try {
        await assert.rejects(
            runtime.invoke("run", [], new LateFlush(), 1000, { wallMs: 50, graceMs: 30, writeGraceMs: 30 }),
            SandboxRuntimeError
        );
        assert.equal(runtime.poisoned, true);
        assert.equal(internals.contextReleased, false, "the context is kept while the host call is pending");
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(internals.contextReleased, true, "the context is freed once the host call settled");
    } finally {
        runtime.dispose();
    }
});

test("a promise callback that runs after the script fails the call instead of dropping its work", async () => {
    const runtime = await SandboxRuntime.create(
        'function run() { var p = Promise.resolve(1); p["then"](function () { return 2 }); return "x" }\n' +
            'function plain() { return "p" }'
    );
    try {
        await assert.rejects(runtime.invoke("run", [], new TestHost(), 1000, { wallMs: 5000 }), (error: unknown) => {
            assert.ok(error instanceof SandboxRuntimeError);
            assert.match(error.message, /promise callback ran after the script/);
            return true;
        });
        assert.equal(await runtime.invoke("plain", [], new TestHost(), 1000, { wallMs: 5000 }), "p");
    } finally {
        runtime.dispose();
    }
});
