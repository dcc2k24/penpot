import assert from "node:assert/strict";
import { test } from "node:test";
import { BusyError, PermitGate } from "./PermitGate";

/** Lets pending callbacks and timers run. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
}

test("a caller that finds no free permit waits, and gets the next one released", async () => {
    const gate = new PermitGate("export", 1);
    await gate.acquire({ waitMs: 1_000 });
    let granted = false;
    const waiting = gate.acquire({ waitMs: 1_000 }).then(() => {
        granted = true;
    });
    await settle();
    assert.equal(granted, false);
    assert.equal(gate.waitingCount, 1);
    gate.release();
    await waiting;
    assert.equal(granted, true);
    gate.release();
});

test("a caller that waits longer than the wait is refused as busy, and leaves the queue", async () => {
    const gate = new PermitGate("export", 1);
    await gate.acquire({ waitMs: 1_000 });
    await assert.rejects(
        gate.acquire({ waitMs: 20 }),
        /export is busy, retry later: no slot was free for 0\.02 seconds/
    );
    assert.equal(gate.waitingCount, 0);
    gate.release();
    // nothing is held by the refused caller, so the permit is free again
    await gate.acquire({ waitMs: 1_000 });
    gate.release();
});

test("a caller refused as busy gets a BusyError whose text starts with Error: export is busy", async () => {
    const gate = new PermitGate("export", 1);
    await gate.acquire({ waitMs: 1_000 });
    const refused = await gate.acquire({ waitMs: 20 }).then(
        () => undefined,
        (error: unknown) => error
    );
    assert.ok(refused instanceof BusyError);
    assert.equal(refused.message, "export is busy, retry later: no slot was free for 0.02 seconds.");
    assert.ok(String(refused).startsWith("Error: export is busy"));
    gate.release();
});

test("a caller whose signal fires while it waits leaves the queue, and never takes a permit later", async () => {
    const gate = new PermitGate("export", 1);
    await gate.acquire({ waitMs: 1_000 });
    const controller = new AbortController();
    const waiting = gate.acquire({ waitMs: 1_000, signal: controller.signal });
    await settle();
    controller.abort(new Error("the caller went away"));
    await assert.rejects(waiting, /the caller went away/);
    assert.equal(gate.waitingCount, 0);
    gate.release();
    // the released permit is free, not handed to the caller that left
    await gate.acquire({ waitMs: 1_000 });
    gate.release();
});

test("a signal that has already fired refuses the call without queueing it", async () => {
    const gate = new PermitGate("export", 1);
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await assert.rejects(gate.acquire({ waitMs: 1_000, signal: controller.signal }), /already gone/);
    assert.equal(gate.waitingCount, 0);
});

test("heldCount counts the permits held, and a hand-over keeps the count at the cap", async () => {
    const gate = new PermitGate("export", 1);
    assert.equal(gate.heldCount, 0);
    await gate.acquire({ waitMs: 1_000 });
    assert.equal(gate.heldCount, 1);
    const waiting = gate.acquire({ waitMs: 1_000 });
    await settle();
    gate.release();
    await waiting;
    assert.equal(gate.heldCount, 1);
    gate.release();
    assert.equal(gate.heldCount, 0);
});

test("a gate needs at least one permit", () => {
    assert.throws(() => new PermitGate("export", 0), /at least 1 permit/);
});
