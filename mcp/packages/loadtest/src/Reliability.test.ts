import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ResultComparison } from "./Compare.js";
import { ResultFile } from "./ResultFile.js";
import { HtmlReport } from "./Report.js";
import { sampleResult } from "./testing/SampleResult.js";

describe("comparison of percentiles with too few samples", () => {
    test("a p95 from fewer than 200 samples is not measured, even when it is far slower", () => {
        const baseline = sampleResult({ calls: 300, p95: 100 });
        const candidate = sampleResult({ calls: 20, p95: 900 });
        const report = new ResultComparison().compare(baseline, candidate, "base", "cand");
        const row = report.rows.find((item) => item.scope === "total" && item.metric === "p95");
        assert.ok(row);
        assert.equal(row.notMeasured, true);
        assert.equal(row.regression, false);
        assert.equal(row.changePct, null);
        assert.equal(report.notMeasured > 0, true);
        assert.match(ResultComparison.format(report), /NOT MEASURED/);
    });

    test("a p95 from 200 samples on both sides is compared as before", () => {
        const baseline = sampleResult({ calls: 200, p95: 100 });
        const candidate = sampleResult({ calls: 200, p95: 110 });
        const report = new ResultComparison().compare(baseline, candidate, "base", "cand");
        const row = report.rows.find((item) => item.scope === "total" && item.metric === "p95");
        assert.ok(row);
        assert.equal(row.notMeasured, false);
        assert.equal(row.regression, false);
        assert.equal(report.rows.filter((item) => item.scope === "total" && item.notMeasured).length, 0);
    });

    test("a p50 from 19 samples is not measured, and the max is always measured", () => {
        const baseline = sampleResult({ calls: 19, p50: 10, max: 50 });
        const candidate = sampleResult({ calls: 19, p50: 40, max: 500 });
        const report = new ResultComparison().compare(baseline, candidate, "base", "cand");
        const p50 = report.rows.find((item) => item.scope === "total" && item.metric === "p50");
        const max = report.rows.find((item) => item.scope === "total" && item.metric === "max");
        assert.equal(p50?.notMeasured, true);
        assert.equal(max?.notMeasured, false);
        assert.equal(max?.regression, true);
    });
});

describe("report marks of percentiles with too few samples", () => {
    test("the summary prints the mark next to an unreliable percentile", () => {
        const html = HtmlReport.render(sampleResult({ calls: 50 }));
        assert.match(html, /<dt>p95<\/dt><dd>[^<]*\(unreliable: 50 samples, needs 200\)<\/dd>/);
        assert.doesNotMatch(html, /<dt>p50<\/dt><dd>[^<]*unreliable/, "50 samples are enough for p50");
    });

    test("a reliable run carries no mark", () => {
        const base = sampleResult();
        const html = HtmlReport.render(
            sampleResult({ calls: 500, steps: base.steps.map((step) => ({ ...step, calls: 500 })) })
        );
        assert.doesNotMatch(html, /unreliable/);
    });

    test("the warm-up and tree state appear in the summary", () => {
        const html = HtmlReport.render(
            sampleResult({
                warmup: { spec: "200 calls", excludedCalls: 200 },
                treeDirty: true,
                backendFlags: "enable-x",
                dbPoolSize: 16,
            })
        );
        assert.match(html, /200 calls, 200 calls excluded/);
        assert.match(html, /uncommitted changes/);
        assert.match(html, /enable-x/);
        assert.match(html, /<dd>16<\/dd>/);
    });
});

describe("result schema, provenance fields", () => {
    test("a result from before schema 2 still validates", () => {
        assert.doesNotThrow(() => ResultFile.validate(sampleResult(), "old.json"));
    });

    test("a warm-up without its excluded count is refused", () => {
        const bad = { ...sampleResult(), warmup: { spec: "2 calls" } };
        assert.throws(() => ResultFile.validate(bad, "bad.json"), /warmup\.excludedCalls must be a finite number/);
    });

    test("a tree flag that is not a boolean is refused", () => {
        const bad = { ...sampleResult(), treeDirty: "yes" };
        assert.throws(() => ResultFile.validate(bad, "bad.json"), /treeDirty must be a boolean or null/);
    });
});
