import assert from "node:assert/strict";
import { test } from "node:test";
import { FileWriteQueue } from "./FileWriteQueue";
import { CallContext } from "./CallContext";

/** Resolves after the given number of milliseconds. */
function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("writes to one file run in submission order even when an earlier one is slower", async () => {
    const queue = new FileWriteQueue();
    const order: string[] = [];
    const slow = queue.run("token", "file-1", async () => {
        await delay(30);
        order.push("first");
    });
    const fast = queue.run("token", "file-1", async () => {
        order.push("second");
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["first", "second"]);
});

test("a failed write does not block the next write to the same file", async () => {
    const queue = new FileWriteQueue();
    const failing = queue.run("token", "file-1", async () => {
        throw new Error("write failed");
    });
    const next = queue.run("token", "file-1", async () => "done");
    await assert.rejects(failing, /write failed/);
    assert.equal(await next, "done");
});

test("writes to different files are not serialised", async () => {
    const queue = new FileWriteQueue();
    const order: string[] = [];
    const slow = queue.run("token", "file-1", async () => {
        await delay(30);
        order.push("file-1");
    });
    const fast = queue.run("token", "file-2", async () => {
        order.push("file-2");
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["file-2", "file-1"]);
});

test("writes of different tokens to the same file are not serialised", async () => {
    const queue = new FileWriteQueue();
    const order: string[] = [];
    const slow = queue.run("token-a", "file-1", async () => {
        await delay(30);
        order.push("token-a");
    });
    const fast = queue.run("token-b", "file-1", async () => {
        order.push("token-b");
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ["token-b", "token-a"]);
});

test("drops the queue entry of every file once its writes settle, including failed ones", async () => {
    const queue = new FileWriteQueue();
    const ok = queue.run("token", "file-1", async () => "done");
    const failing = queue.run("token", "file-2", async () => {
        throw new Error("write failed");
    });
    assert.equal(queue.pendingFileCount, 2);
    await Promise.allSettled([ok, failing]);
    // the entry is removed in a microtask after the write settles, so let the queue drain first
    await delay(0);
    assert.equal(queue.pendingFileCount, 0);
});

test("returns the result of the task", async () => {
    const queue = new FileWriteQueue();
    assert.equal(await queue.run("token", "file-1", async () => 42), 42);
});

test("a queued write whose signal fires before it starts is skipped and rejects with an AbortError", async () => {
    const queue = new FileWriteQueue();
    const controller = new AbortController();
    let skippedRan = false;
    const first = queue.run("token", "file-1", async () => {
        await delay(30);
    });
    const second = queue.run(
        "token",
        "file-1",
        async () => {
            skippedRan = true;
        },
        controller.signal
    );
    controller.abort();
    await first;
    await assert.rejects(second, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    assert.equal(skippedRan, false);
});

test("a write that has started ignores its signal and finishes", async () => {
    const queue = new FileWriteQueue();
    const controller = new AbortController();
    let finished = false;
    const write = queue.run(
        "token",
        "file-1",
        async () => {
            controller.abort();
            await delay(10);
            finished = true;
            return "done";
        },
        controller.signal
    );
    assert.equal(await write, "done");
    assert.equal(finished, true);
});

test("a write runs without the signal of the call that queued it", async () => {
    const queue = new FileWriteQueue();
    const controller = new AbortController();
    const seen = await CallContext.run({ requestId: "req-1", signal: controller.signal }, () =>
        queue.run("token", "file-1", async () => CallContext.current()?.signal)
    );
    assert.equal(seen, undefined);
});

test("a queued write takes the signal of the current call when none is given", async () => {
    const queue = new FileWriteQueue();
    const controller = new AbortController();
    const first = queue.run("token", "file-1", async () => {
        await delay(30);
    });
    const second = CallContext.run({ signal: controller.signal }, () =>
        queue.run("token", "file-1", async () => "unreachable")
    );
    controller.abort();
    await first;
    await assert.rejects(second, { name: "AbortError" });
});
