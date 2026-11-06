import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { DomMismatch, TargetDomResult } from "./DomCompare.js";
import type { PixelResult } from "./PixelCompare.js";
import { type CompareReport, mergeReports, readReport, ReportWriter } from "./Report.js";

const root = mkdtempSync(join(tmpdir(), "cmp-report-"));
const diffFile = join(root, "x-diff.png");
writeFileSync(diffFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

after(() => {
    rmSync(root, { recursive: true, force: true });
});

/**
 * Builds a DOM result of one target for the merge tests. Every target has two checked nodes.
 * @param id - id of the target
 * @param mismatches - number of mismatches of the target
 * @returns the target result
 */
function domTarget(id: string, mismatches: number): TargetDomResult {
    return { id, name: id, nodes: 2, checked: 2, mismatches, info: [], duplicates: [] };
}

/**
 * Builds one DOM mismatch of a target for the merge tests.
 * @param targetId - id of the target that holds the node
 * @param attribute - attribute that differs
 * @returns the mismatch
 */
function domMismatch(targetId: string, attribute: string): DomMismatch {
    return {
        targetId,
        targetName: targetId,
        nodeId: `${targetId}-node`,
        nodeName: "Title",
        path: "root/Title",
        attribute,
        design: "1",
        implemented: "2",
        tolerance: "0",
    };
}

/**
 * Builds an ok pixel result that is over budget or not, for the merge tests.
 * @param targetId - id of the target
 * @param percent - share of the different pixels in percent
 * @returns the pixel result
 */
function okPixel(targetId: string, percent: number): PixelResult {
    return { targetId, status: "ok", percent, budget: 0.5, overBudget: percent > 0.5, cause: null };
}

/**
 * Builds a report for the merge tests.
 * @param generatedFrom - pull time of the design the report was made from
 * @param targets - DOM results of the targets
 * @param mismatches - DOM mismatches of the targets
 * @param pixel - pixel results, or null when the pixel step did not run
 * @returns the report
 */
function runReport(
    generatedFrom: string,
    targets: TargetDomResult[],
    mismatches: DomMismatch[],
    pixel: PixelResult[] | null
): CompareReport {
    return {
        generatedFrom,
        viewport: { width: 1440, height: 900 },
        dom: { targets, mismatches, checked: targets.length * 2, info: 0 },
        pixel,
        budgets: { component: 1, screen: 0.5 },
    };
}

/**
 * Builds a small report with one target, one DOM mismatch and one pixel result with a diff image.
 * @returns the fixture report
 */
function fixtureReport(): CompareReport {
    return {
        generatedFrom: "design-2026-11-04",
        viewport: { width: 1280, height: 720 },
        dom: {
            targets: [
                {
                    id: "page/home",
                    name: "Home",
                    nodes: 1,
                    checked: 1,
                    mismatches: 1,
                    info: ["one note"],
                    duplicates: [],
                },
            ],
            mismatches: [
                {
                    targetId: "page/home",
                    targetName: "Home",
                    nodeId: "node-1",
                    nodeName: "<b>Title</b>",
                    path: "root/0",
                    attribute: "fill",
                    design: "#ffffff",
                    implemented: "#000000",
                    tolerance: "0",
                    classification: "renderer",
                },
            ],
            checked: 1,
            info: 1,
        },
        pixel: [
            {
                targetId: "page/home",
                status: "ok",
                differentPixels: 10,
                totalPixels: 2000,
                percent: 0.5,
                files: [join(root, "page-home-design.png"), join(root, "page-home-app.png"), diffFile],
            },
        ],
        budgets: { component: 1, screen: 0.5 },
        scale: 2,
    };
}

test("write creates report.json and report.html with sorted JSON keys", async () => {
    const dir = join(root, "a");
    const report = fixtureReport();
    const paths = await new ReportWriter().write(report, dir);

    assert.equal(paths.json, join(dir, "report.json"));
    assert.equal(paths.html, join(dir, "report.html"));

    const parsed = JSON.parse(readFileSync(paths.json, "utf8")) as Record<string, unknown>;
    assert.deepEqual(parsed, report);
    assert.equal(parsed.scale, 2);
    assert.deepEqual(Object.keys(parsed), ["budgets", "dom", "generatedFrom", "pixel", "scale", "viewport"]);
    assert.deepEqual(parsed.budgets, { component: 1, screen: 0.5 });
    assert.ok(readFileSync(paths.json, "utf8").endsWith("}\n"));
});

test("HTML report contains no http:// or https:// text", async () => {
    const dir = join(root, "b");
    const paths = await new ReportWriter().write(fixtureReport(), dir);
    const html = readFileSync(paths.html, "utf8");

    assert.ok(!html.includes("http://"));
    assert.ok(!html.includes("https://"));
    assert.ok(html.includes("<title>Design parity report</title>"));
    assert.ok(!html.includes("<script"));
});

test("HTML report escapes node names", async () => {
    const dir = join(root, "c");
    const paths = await new ReportWriter().write(fixtureReport(), dir);
    const html = readFileSync(paths.html, "utf8");

    assert.ok(html.includes("&lt;b&gt;Title&lt;/b&gt;"));
    assert.ok(!html.includes("<b>Title</b>"));
});

test("same report written twice gives identical bytes", async () => {
    const report = fixtureReport();
    const first = await new ReportWriter().write(report, join(root, "d1"));
    const second = await new ReportWriter().write(report, join(root, "d2"));

    assert.deepEqual(readFileSync(first.json), readFileSync(second.json));
    assert.deepEqual(readFileSync(first.html), readFileSync(second.html));
});

test("HTML report lists an over-budget target with its cause, or with no cause recorded", async () => {
    const report = fixtureReport();
    report.pixel = [{ ...okPixel("page/home", 0.8), differentPixels: 16, totalPixels: 2000 }];

    const without = readFileSync((await new ReportWriter().write(report, join(root, "e1"))).html, "utf8");
    assert.ok(without.includes("Pixel over budget"));
    assert.ok(without.includes("no cause recorded"));

    report.pixel = [{ ...okPixel("page/home", 0.8), cause: "header offset, see page-home-diff.png" }];
    const withCause = readFileSync((await new ReportWriter().write(report, join(root, "e2"))).html, "utf8");
    assert.ok(withCause.includes("header offset, see page-home-diff.png"));
    assert.ok(!withCause.includes("no cause recorded"));
});

test("HTML report says when no target is over budget", async () => {
    const report = fixtureReport();
    report.pixel = [okPixel("page/home", 0.2)];
    const html = readFileSync((await new ReportWriter().write(report, join(root, "f"))).html, "utf8");
    assert.ok(html.includes("No target is over its pixel budget."));
});

test("readReport gives null for a missing file, an unparsable file and an older report with no budgets", () => {
    const missing = join(root, "missing", "report.json");
    assert.equal(readReport(missing), null);

    const broken = join(root, "broken.json");
    writeFileSync(broken, "{ not json");
    assert.equal(readReport(broken), null);

    const older = join(root, "older.json");
    writeFileSync(older, JSON.stringify({ budgetPercent: 2, dom: { targets: [], mismatches: [] } }));
    assert.equal(readReport(older), null);
});

test("readReport returns a report that ReportWriter wrote", async () => {
    const report = fixtureReport();
    const paths = await new ReportWriter().write(report, join(root, "g"));
    assert.deepEqual(readReport(paths.json), report);
});

test("mergeReports without a previous report returns the run", () => {
    const fresh = runReport("pull-1", [domTarget("a", 0), domTarget("b", 1)], [domMismatch("b", "fill")], null);
    assert.deepEqual(mergeReports(null, fresh, ["a", "b"], ["a", "b"]), fresh);
});

test("mergeReports keeps the entries of targets that were not rerun", () => {
    const previous = runReport(
        "pull-1",
        [domTarget("a", 1), domTarget("b", 1)],
        [domMismatch("a", "fill"), domMismatch("b", "fill")],
        null
    );
    const fresh = runReport("pull-1", [domTarget("b", 1)], [domMismatch("b", "color")], null);
    const merged = mergeReports(previous, fresh, ["b"], ["a", "b"]);

    assert.deepEqual(merged.dom.targets, [domTarget("a", 1), domTarget("b", 1)]);
    assert.deepEqual(merged.dom.mismatches, [domMismatch("a", "fill"), domMismatch("b", "color")]);
    assert.equal(merged.dom.checked, 4);
    assert.equal(merged.generatedFrom, "pull-1");
});

test("mergeReports removes the mismatches of a rerun target that now passes", () => {
    const previous = runReport(
        "pull-1",
        [domTarget("a", 1), domTarget("b", 1)],
        [domMismatch("a", "fill"), domMismatch("b", "fill")],
        null
    );
    const fresh = runReport("pull-1", [domTarget("b", 0)], [], null);
    const merged = mergeReports(previous, fresh, ["b"], ["a", "b"]);

    assert.deepEqual(merged.dom.targets, [domTarget("a", 1), domTarget("b", 0)]);
    assert.deepEqual(merged.dom.mismatches, [domMismatch("a", "fill")]);
});

test("mergeReports orders the rebuilt lists by the model order, not by the run order", () => {
    const previous = runReport("pull-1", [domTarget("a", 0), domTarget("b", 0)], [], null);
    const fresh = runReport(
        "pull-1",
        [domTarget("b", 1), domTarget("a", 1)],
        [domMismatch("a", "x"), domMismatch("b", "y")],
        null
    );
    const merged = mergeReports(previous, fresh, ["a", "b"], ["a", "b"]);

    assert.deepEqual(
        merged.dom.targets.map((target) => target.id),
        ["a", "b"]
    );
    assert.deepEqual(
        merged.dom.mismatches.map((mismatch) => mismatch.targetId),
        ["a", "b"]
    );
});

test("mergeReports replaces the pixel result of a rerun target and keeps the others", () => {
    const previous = runReport(
        "pull-1",
        [domTarget("a", 0), domTarget("b", 0)],
        [],
        [okPixel("a", 0.9), okPixel("b", 0.1)]
    );
    const fresh = runReport("pull-1", [domTarget("a", 0)], [], [okPixel("a", 0.2)]);
    const merged = mergeReports(previous, fresh, ["a"], ["a", "b"]);

    assert.deepEqual(merged.pixel, [okPixel("a", 0.2), okPixel("b", 0.1)]);
});

test("mergeReports keeps the previous pixel results when the run had no pixel step", () => {
    const previous = runReport(
        "pull-1",
        [domTarget("a", 0), domTarget("b", 0)],
        [],
        [okPixel("a", 0.9), okPixel("b", 0.1)]
    );
    const fresh = runReport("pull-1", [domTarget("a", 1)], [domMismatch("a", "fill")], null);
    const merged = mergeReports(previous, fresh, ["a"], ["a", "b"]);

    assert.deepEqual(merged.pixel, [okPixel("a", 0.9), okPixel("b", 0.1)]);
    assert.deepEqual(merged.dom.mismatches, [domMismatch("a", "fill")]);
});

test("mergeReports returns the run when the previous report is from another pull", () => {
    const previous = runReport("pull-0", [domTarget("a", 3), domTarget("b", 3)], [], null);
    const fresh = runReport("pull-1", [domTarget("a", 0)], [], null);
    assert.deepEqual(mergeReports(previous, fresh, ["a"], ["a", "b"]), fresh);
});

test("mergeReports drops the previous pixel results when the pixel run uses another scale", () => {
    const previous = {
        ...runReport("pull-1", [domTarget("a", 0), domTarget("b", 0)], [], [okPixel("a", 0.9), okPixel("b", 0.1)]),
        scale: 2,
    };
    const fresh = { ...runReport("pull-1", [domTarget("a", 0)], [], [okPixel("a", 0.2)]), scale: 3 };
    const merged = mergeReports(previous, fresh, ["a"], ["a", "b"]);

    assert.deepEqual(merged.pixel, [okPixel("a", 0.2)]);
    assert.equal(merged.scale, 3);
});

test("mergeReports keeps the previous pixel results and scale when the run has no pixel step", () => {
    const previous = {
        ...runReport("pull-1", [domTarget("a", 0), domTarget("b", 0)], [], [okPixel("a", 0.9), okPixel("b", 0.1)]),
        scale: 3,
    };
    const fresh = {
        ...runReport("pull-1", [domTarget("a", 1)], [domMismatch("a", "fill")], null),
        scale: 2,
    };
    const merged = mergeReports(previous, fresh, ["a"], ["a", "b"]);

    assert.deepEqual(merged.pixel, [okPixel("a", 0.9), okPixel("b", 0.1)]);
    assert.equal(merged.scale, 3);
});

test("HTML report lists a target with a largest cluster above 12 pixels as a real mismatch, and one at 12 is not", async () => {
    const report = fixtureReport();
    report.pixel = [
        { ...okPixel("page/big", 0.3), largestCluster: 13, clusters: 2, realMismatch: true },
        { ...okPixel("page/small", 0.3), largestCluster: 12, clusters: 4, realMismatch: false },
    ];
    const html = readFileSync((await new ReportWriter().write(report, join(root, "h"))).html, "utf8");

    const start = html.indexOf("<h2>Real mismatches (largest cluster above 12 pixels)</h2>");
    assert.ok(start >= 0);
    const section = html.slice(start, html.indexOf("<h2>", start + 1));
    assert.ok(section.includes("page/big, 0.3%, largest cluster 13 px"));
    assert.ok(!section.includes("page/small"));
});

test("HTML report says when no target is a real mismatch", async () => {
    const report = fixtureReport();
    report.pixel = [{ ...okPixel("page/small", 0.3), largestCluster: 12, clusters: 4, realMismatch: false }];
    const html = readFileSync((await new ReportWriter().write(report, join(root, "i"))).html, "utf8");
    assert.ok(html.includes("No target has a real mismatch."));
});
