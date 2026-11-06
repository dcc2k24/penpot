import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LatencyRecorder, percentile } from "./Statistics.js";

describe("percentile", () => {
    test("uses the nearest rank over sorted samples", () => {
        const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
        assert.equal(percentile(hundred, 50), 50);
        assert.equal(percentile(hundred, 95), 95);
        assert.equal(percentile(hundred, 99), 99);
        assert.equal(percentile(hundred, 100), 100);
    });

    test("rounds the rank up for small samples", () => {
        assert.equal(percentile([1, 2, 3], 50), 2);
        assert.equal(percentile([1, 2, 3], 95), 3);
        assert.equal(percentile([10, 20, 30, 40], 50), 20);
        assert.equal(percentile([10, 20, 30, 40], 25), 10);
    });

    test("a single sample is every percentile", () => {
        assert.equal(percentile([42], 1), 42);
        assert.equal(percentile([42], 99), 42);
    });

    test("an empty sample reads as zero", () => {
        assert.equal(percentile([], 95), 0);
    });
});

describe("LatencyRecorder", () => {
    test("summarises unsorted samples", () => {
        const recorder = new LatencyRecorder();
        for (const value of [30, 10, 20, 40]) {
            recorder.add(value);
        }
        assert.equal(recorder.count, 4);
        assert.deepEqual(recorder.summary(), { count: 4, p50: 20, p95: 40, p99: 40, max: 40 });
    });

    test("an empty recorder summarises to zeros", () => {
        assert.deepEqual(new LatencyRecorder().summary(), { count: 0, p50: 0, p95: 0, p99: 0, max: 0 });
    });
});
