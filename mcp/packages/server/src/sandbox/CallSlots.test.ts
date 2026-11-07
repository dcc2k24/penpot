import assert from "node:assert/strict";
import { test } from "node:test";
import { CallSlots } from "./CallSlots";

test("calls up to the cap run at once and the next call waits", async () => {
    const slots = new CallSlots(2, 1000);
    const first = await slots.acquire();
    const second = await slots.acquire();
    assert.equal(slots.running, 2);
    let thirdGranted = false;
    const third = slots.acquire().then((release) => {
        thirdGranted = true;
        return release;
    });
    assert.equal(slots.queued, 1);
    assert.equal(thirdGranted, false);
    first();
    const releaseThird = await third;
    assert.equal(thirdGranted, true);
    assert.equal(slots.running, 2);
    assert.equal(slots.queued, 0);
    releaseThird();
    second();
    assert.equal(slots.running, 0);
});

test("released slots go to the waiting calls in first-in, first-out order", async () => {
    const slots = new CallSlots(1, 1000);
    const first = await slots.acquire();
    const granted: string[] = [];
    const second = slots.acquire().then((release) => {
        granted.push("second");
        return release;
    });
    const third = slots.acquire().then((release) => {
        granted.push("third");
        return release;
    });
    assert.equal(slots.queued, 2);
    first();
    const releaseSecond = await second;
    assert.deepEqual(granted, ["second"]);
    assert.equal(slots.running, 1);
    assert.equal(slots.queued, 1);
    releaseSecond();
    const releaseThird = await third;
    assert.deepEqual(granted, ["second", "third"]);
    releaseThird();
    assert.equal(slots.running, 0);
    assert.equal(slots.queued, 0);
});

test("a call that waits past the limit is rejected with the busy message and leaves the queue", async () => {
    const slots = new CallSlots(2, 20);
    const first = await slots.acquire();
    const second = await slots.acquire();
    await assert.rejects(slots.acquire(), {
        message: "execute_code is busy: 2 calls are already running; retry in a moment.",
    });
    assert.equal(slots.queued, 0);
    assert.equal(slots.running, 2);
    first();
    assert.equal(slots.running, 1);
    second();
    assert.equal(slots.running, 0);
});

test("calling a release function twice frees one slot only", async () => {
    const slots = new CallSlots(1, 1000);
    const release = await slots.acquire();
    const second = slots.acquire();
    let thirdGranted = false;
    const third = slots.acquire().then((next) => {
        thirdGranted = true;
        return next;
    });
    release();
    release();
    const releaseSecond = await second;
    assert.equal(slots.running, 1);
    assert.equal(slots.queued, 1);
    assert.equal(thirdGranted, false);
    releaseSecond();
    const releaseThird = await third;
    releaseThird();
    assert.equal(slots.running, 0);
});

test("a call past the queue limit is refused at once, without waiting", async () => {
    const turn = new CallSlots(1, 1000, 2);
    const running = await turn.acquire();
    const queuedOne = turn.acquire();
    const queuedTwo = turn.acquire();
    await assert.rejects(turn.acquire(), {
        message: "execute_code is busy: 1 running and 2 queued; retry in a moment.",
    });
    assert.equal(turn.queued, 2);
    running();
    (await queuedOne)();
    (await queuedTwo)();
    assert.equal(turn.running, 0);
});
