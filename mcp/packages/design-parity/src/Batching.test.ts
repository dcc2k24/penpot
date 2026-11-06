import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitIntoBatches } from "./Batching.js";

describe("splitIntoBatches", () => {
    it("never splits a group across batches", () => {
        const groups = [
            ["a1", "a2", "a3"],
            ["b1", "b2", "b3"],
            ["c1", "c2"],
        ];
        const batches = splitIntoBatches(groups, 4);
        assert.deepEqual(batches, [
            ["a1", "a2", "a3"],
            ["b1", "b2", "b3"],
            ["c1", "c2"],
        ]);
    });

    it("keeps every batch within the operation limit", () => {
        const groups = Array.from({ length: 50 }, (_, index) =>
            Array.from({ length: 7 }, (__, op) => `${index}-${op}`)
        );
        const batches = splitIntoBatches(groups, 300);
        assert.ok(batches.every((batch) => batch.length <= 300));
        assert.equal(batches.flat().length, 350);
    });

    it("preserves the order of groups and of operations", () => {
        const groups = [["x1", "x2"], ["y1"], ["z1", "z2", "z3"], ["w1"]];
        const batches = splitIntoBatches(groups, 3);
        assert.deepEqual(batches.flat(), ["x1", "x2", "y1", "z1", "z2", "z3", "w1"]);
        assert.deepEqual(batches, [["x1", "x2", "y1"], ["z1", "z2", "z3"], ["w1"]]);
    });

    it("throws for a single group larger than the limit", () => {
        assert.throws(() => splitIntoBatches([["a", "b", "c", "d"]], 3), RangeError);
    });

    it("returns no batches for no groups and drops empty groups", () => {
        assert.deepEqual(splitIntoBatches([], 300), []);
        assert.deepEqual(splitIntoBatches([[], ["only"], []], 300), [["only"]]);
    });

    it("defaults to 300 operations per batch", () => {
        const groups = [
            Array.from({ length: 200 }, (_, index) => index),
            Array.from({ length: 200 }, (_, index) => index),
        ];
        const batches = splitIntoBatches(groups);
        assert.equal(batches.length, 2);
        assert.equal(batches[0]?.length, 200);
        assert.equal(batches[1]?.length, 200);
    });
});
