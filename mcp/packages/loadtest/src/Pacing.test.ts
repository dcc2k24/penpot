import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ArrivalSchedule, parseWarmup, WarmupGate } from "./Pacing.js";

describe("WarmupGate", () => {
    test("without a spec nothing is excluded", () => {
        const gate = new WarmupGate(undefined, 0);
        assert.equal(gate.excludes(1), false);
        assert.equal(gate.excludedCalls, 0);
    });

    test("the first N calls are excluded, then every call counts", () => {
        const gate = new WarmupGate({ calls: 2 }, 0);
        assert.deepEqual(
            [1, 2, 3, 4].map((time) => gate.excludes(time)),
            [true, true, false, false]
        );
        assert.equal(gate.excludedCalls, 2);
    });

    test("a duration excludes the calls that finish before it ends", () => {
        const gate = new WarmupGate({ durationMs: 1000 }, 500);
        assert.equal(gate.excludes(1499), true);
        assert.equal(gate.excludes(1500), false);
        assert.equal(gate.excludes(2000), false);
        assert.equal(gate.excludedCalls, 1);
    });
});

describe("ArrivalSchedule", () => {
    test("calls are due at fixed intervals from the start, whatever the call times are", () => {
        const schedule = new ArrivalSchedule(10, 1000);
        assert.deepEqual(
            [0, 1, 2, 3].map(() => schedule.reserve()),
            [1000, 1100, 1200, 1300]
        );
    });
});

describe("parseWarmup", () => {
    test("a whole number is a count of calls", () => {
        assert.deepEqual(parseWarmup("200"), { calls: 200 });
    });

    test("a number with a unit is a time in milliseconds", () => {
        assert.deepEqual(parseWarmup("60s"), { durationMs: 60_000 });
        assert.deepEqual(parseWarmup("2m"), { durationMs: 120_000 });
        assert.deepEqual(parseWarmup(" 1h "), { durationMs: 3_600_000 });
    });

    test("refuses zero calls, zero time and a value with no unit or a bad unit", () => {
        assert.throws(() => parseWarmup("0"), /at least 1 call/);
        assert.throws(() => parseWarmup("0s"), /longer than zero/);
        assert.throws(() => parseWarmup("1.5"), /--warmup must be/);
        assert.throws(() => parseWarmup("10ms"), /--warmup must be/);
        assert.throws(() => parseWarmup("soon"), /--warmup must be/);
    });
});
