import assert from "node:assert/strict";
import { test } from "node:test";
import { ImportGate } from "./ImportGate";

/** A task that holds its turn until the returned release function is called. */
function holdingTask(): { task: () => Promise<string>; release: () => void } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { task: async () => (await gate, "done"), release };
}

/** Lets pending promise callbacks and timers run. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
}

test("a task runs and its value is returned", async () => {
    const gate = new ImportGate(2, 8, 1_000);
    assert.equal(await gate.withPermit(async () => 42), 42);
    assert.equal(gate.waitingCount, 0);
});

test("two imports run at once and a third waits for a turn", async () => {
    const gate = new ImportGate(2, 8, 1_000);
    const first = holdingTask();
    const second = holdingTask();
    const third = holdingTask();
    const runs = [gate.withPermit(first.task), gate.withPermit(second.task), gate.withPermit(third.task)];
    await settle();
    assert.equal(gate.waitingCount, 1);
    first.release();
    await settle();
    assert.equal(gate.waitingCount, 0, "the freed turn goes to the waiting import");
    second.release();
    third.release();
    assert.deepEqual(await Promise.all(runs), ["done", "done", "done"]);
});

test("a caller above the waiting limit is refused at once with busy, retry later", async () => {
    const gate = new ImportGate(1, 1, 1_000);
    const running = holdingTask();
    const waiting = holdingTask();
    const refused = holdingTask();
    const first = gate.withPermit(running.task);
    const second = gate.withPermit(waiting.task);
    await settle();
    await assert.rejects(gate.withPermit(refused.task), /busy, retry later: too many archive imports/);
    running.release();
    waiting.release();
    await Promise.all([first, second]);
});

test("a caller that waits longer than the limit is refused with busy, retry later", async () => {
    const gate = new ImportGate(1, 8, 20);
    const running = holdingTask();
    const first = gate.withPermit(running.task);
    await assert.rejects(
        gate.withPermit(async () => "late"),
        /busy, retry later: the import waited 0.02 seconds/
    );
    assert.equal(gate.waitingCount, 0, "the timed-out caller leaves the queue");
    running.release();
    await first;
});

test("a timed-out caller does not take the turn of the next waiting caller", async () => {
    const gate = new ImportGate(1, 8, 30);
    const running = holdingTask();
    const first = gate.withPermit(running.task);
    const timedOut = gate.withPermit(async () => "never");
    await assert.rejects(timedOut, /busy, retry later/);
    running.release();
    assert.equal(await first, "done");
    assert.equal(await gate.withPermit(async () => "next"), "next");
});
