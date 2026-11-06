import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseRerunIds, classifyAttribute, failedTargetIds } from "./LoopCommand.js";
import type { CompareReport } from "./compare/Report.js";
import type { PixelResult } from "./compare/PixelCompare.js";

/**
 * Builds a report with the given DOM mismatch counts and pixel results, for the selection tests.
 *
 * @param generatedFrom - pull time of the design the report was made from
 * @param counts - DOM mismatch count of each target, keyed by target id
 * @param pixel - pixel results, or null when the pixel step did not run
 */
function reportWith(
    generatedFrom: string,
    counts: Record<string, number>,
    pixel: PixelResult[] | null = null
): CompareReport {
    return {
        generatedFrom,
        viewport: { width: 1440, height: 900 },
        dom: {
            targets: Object.entries(counts).map(([id, mismatches]) => ({
                id,
                name: id,
                nodes: 1,
                checked: 1,
                mismatches,
                info: [],
                duplicates: [],
            })),
            mismatches: [],
            checked: Object.keys(counts).length,
            info: 0,
        },
        pixel,
        budgets: { component: 1, screen: 0.5 },
    };
}

describe("failedTargetIds", () => {
    it("lists the targets with DOM mismatches", () => {
        const report = reportWith("pull-1", { a: 0, b: 2, c: 0, d: 1 });
        assert.deepEqual(failedTargetIds(report), ["b", "d"]);
    });

    it("ignores pixel results, so a target over its pixel budget with no DOM mismatch is not failed", () => {
        const pixel: PixelResult[] = [
            { targetId: "a", status: "ok", percent: 0.9, budget: 0.5, overBudget: true, cause: null },
            { targetId: "b", status: "ok", percent: 0.9, budget: 0.5, overBudget: true, cause: null },
            { targetId: "c", status: "ok", percent: 0.1, budget: 0.5, overBudget: false, cause: null },
            { targetId: "d", status: "unavailable", reason: "export failed" },
        ];
        const report = reportWith("pull-1", { a: 1, b: 0, c: 0, d: 0 }, pixel);
        assert.deepEqual(failedTargetIds(report), ["a"]);
    });

    it("gives an empty list when no target failed", () => {
        assert.deepEqual(failedTargetIds(reportWith("pull-1", { a: 0, b: 0 })), []);
    });
});

describe("chooseRerunIds", () => {
    const order = ["a", "b", "c"];

    it("runs every target with no report", () => {
        assert.deepEqual(chooseRerunIds(null, "pull-1", order, false), order);
    });

    it("runs every target when --all is given", () => {
        const report = reportWith("pull-1", { a: 0, b: 1, c: 0 });
        assert.deepEqual(chooseRerunIds(report, "pull-1", order, true), order);
    });

    it("runs every target when the report has no failed target", () => {
        const report = reportWith("pull-1", { a: 0, b: 0, c: 0 });
        assert.deepEqual(chooseRerunIds(report, "pull-1", order, false), order);
    });

    it("runs only the failed targets, in model order", () => {
        const report = reportWith("pull-1", { a: 0, b: 2, c: 1 });
        assert.deepEqual(chooseRerunIds(report, "pull-1", order, false), ["b", "c"]);
    });

    it("runs every target when the report is from another pull", () => {
        const report = reportWith("pull-0", { a: 0, b: 2, c: 1 });
        assert.deepEqual(chooseRerunIds(report, "pull-1", order, false), order);
    });

    it("runs every target when the report lacks a target of the model", () => {
        const report = reportWith("pull-1", { a: 0, b: 2 });
        assert.deepEqual(chooseRerunIds(report, "pull-1", order, false), order);
    });
});

describe("classifyAttribute", () => {
    it("classes an outline or border attribute as generator", () => {
        assert.equal(classifyAttribute("outline-width"), "generator");
        assert.equal(classifyAttribute("border-width"), "generator");
    });

    it("classes a missing element as generator", () => {
        assert.equal(classifyAttribute("element"), "generator");
    });

    it("classes the position as model-or-generator", () => {
        assert.equal(classifyAttribute("x"), "model-or-generator");
    });

    it("classes a font size as generator", () => {
        assert.equal(classifyAttribute("font-size"), "generator");
    });

    it("classes a background colour as generator", () => {
        assert.equal(classifyAttribute("background-color"), "generator");
    });

    it("classes an unknown attribute as unclassified", () => {
        assert.equal(classifyAttribute("zzz"), "unclassified");
    });
});
