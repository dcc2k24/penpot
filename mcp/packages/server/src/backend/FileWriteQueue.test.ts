import assert from "node:assert/strict";
import { test } from "node:test";
import { FileWriteQueue } from "./FileWriteQueue";

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
