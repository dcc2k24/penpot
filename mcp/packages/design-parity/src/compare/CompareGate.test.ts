import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareExitCode, countPixelFailures } from "./CompareCommand.js";
import type { PixelResult } from "./PixelCompare.js";

/** A pixel result for one target with the fields the gate reads. */
function pixel(fields: Partial<PixelResult> & Pick<PixelResult, "targetId" | "status">): PixelResult {
    return fields as PixelResult;
}

describe("countPixelFailures", () => {
    it("counts nothing when the pixel step did not run", () => {
        assert.equal(countPixelFailures(null), 0);
    });

    it("counts a target over its budget and a target that could not be compared", () => {
        const results = [
            pixel({ targetId: "a", status: "ok", overBudget: false, percent: 0.2, budget: 1 }),
            pixel({ targetId: "b", status: "ok", overBudget: true, percent: 1.4, budget: 1 }),
            pixel({ targetId: "c", status: "unavailable", reason: "empty PNG" }),
            pixel({ targetId: "d", status: "size-mismatch" }),
        ];
        assert.equal(countPixelFailures(results), 3);
    });
});

describe("compareExitCode", () => {
    it("is 0 when every check passes", () => {
        assert.equal(compareExitCode({ domMismatches: 0, pixelFailures: 0 }, false), 0);
    });

    it("fails on a DOM mismatch, with or without the pixel step", () => {
        assert.equal(compareExitCode({ domMismatches: 2, pixelFailures: 0 }, false), 1);
        assert.equal(compareExitCode({ domMismatches: 2, pixelFailures: 0 }, true), 1);
    });

    it("fails on a pixel failure: a target over its budget is not a pass", () => {
        assert.equal(compareExitCode({ domMismatches: 0, pixelFailures: 1 }, false), 1);
    });

    it("does not fail on pixel results when the run is advisory", () => {
        assert.equal(compareExitCode({ domMismatches: 0, pixelFailures: 4 }, true), 0);
    });
});
