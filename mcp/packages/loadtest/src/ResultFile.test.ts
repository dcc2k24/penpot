import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ResultComparison } from "./Compare.js";
import { ResultFile, RESULT_SCHEMA_VERSION, type RunResult } from "./ResultFile.js";
import { sampleResult } from "./testing/SampleResult.js";

const directories: string[] = [];

/** Creates an empty directory for one test and remembers it for cleanup. */
async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "mcp-loadtest-result-"));
    directories.push(directory);
    return directory;
}

after(async () => {
    for (const directory of directories) {
        await rm(directory, { recursive: true, force: true });
    }
});

describe("ResultFile", () => {
    test("names a result by date, short commit and scenario", () => {
        const name = ResultFile.fileNameFor(sampleResult({ scenario: "S1 create/pages" }));
        assert.equal(name, "2026-11-04-0123456789-S1-create-pages.json");
    });

    test("uses nogit when the commit is unknown", () => {
        assert.equal(
            ResultFile.fileNameFor(sampleResult({ commit: "unknown", scenario: "setup" })),
            "2026-11-04-nogit-setup.json"
        );
    });

    test("writes and reads back the same document", async () => {
        const directory = await temporaryDirectory();
        const result = sampleResult({ errorSamples: ["boom"], dbStatements: 12 });
        const file = await ResultFile.write(directory, result);
        assert.equal(file, join(directory, "2026-11-04-0123456789-sample.json"));
        const back = await ResultFile.read(file);
        assert.deepEqual(back, result);
        assert.equal(back.schemaVersion, RESULT_SCHEMA_VERSION);
    });

    test("does not overwrite a result written earlier the same day", async () => {
        const directory = await temporaryDirectory();
        const first = await ResultFile.write(directory, sampleResult());
        const second = await ResultFile.write(directory, sampleResult());
        assert.notEqual(first, second);
        assert.match(second, /-2\.json$/);
        const onDisk = JSON.parse(await readFile(first, "utf8")) as { scenario: string };
        assert.equal(onDisk.scenario, "sample");
    });

    test("keeps the optional backend figures through a write and a read", async () => {
        const directory = await temporaryDirectory();
        const result = sampleResult({
            dbStatements: 12,
            dbStatementsSource: "pg_stat_statements",
            backendHeap: { startBytes: 1, endBytes: 2, peakBytes: 3, maxBytes: 4 },
            gc: { seconds: 0.5, collections: 2 },
            backendCpuSeconds: 1.5,
            backendRequests: 9,
            mcpCommands: 7,
            connectionCheckouts: 5,
            pg: {
                statements: 12,
                transactions: 3,
                tableScans: 4,
                rowsRead: 5,
                rowsWritten: 6,
                fileChangeSeqScans: 0,
                fileChangeIdxScans: 2,
            },
            serverRss: { startBytes: 10, endBytes: 20, peakBytes: 30 },
        });
        const file = await ResultFile.write(directory, result);
        assert.deepEqual(await ResultFile.read(file), result);
    });

    test("reports a backend figure that has the wrong type", () => {
        const broken = {
            ...sampleResult(),
            dbStatementsSource: "somewhere",
            backendHeap: { startBytes: 1, endBytes: 2 },
            pg: { transactions: "many" },
            serverRss: null,
        } as unknown;
        assert.throws(
            () => ResultFile.validate(broken, "backend.json"),
            (error: Error) => {
                assert.match(error.message, /dbStatementsSource must be "metrics" or "pg_stat_statements"/);
                assert.match(error.message, /backendHeap\.peakBytes must be a finite number/);
                assert.match(error.message, /pg\.transactions must be a finite number/);
                assert.match(error.message, /serverRss must be an object/);
                return true;
            }
        );
    });

    test("reports every field that does not match the schema", () => {
        const broken = { ...sampleResult(), p95: "slow", heap: null, steps: [{ name: 1 }] } as unknown;
        assert.throws(
            () => ResultFile.validate(broken, "broken.json"),
            (error: Error) => {
                assert.match(error.message, /broken\.json is not a valid result/);
                assert.match(error.message, /p95 must be a finite number/);
                assert.match(error.message, /heap must be an object/);
                assert.match(error.message, /steps\[0\]\.name must be a string/);
                return true;
            }
        );
    });

    test("rejects a file that is not a JSON object", async () => {
        const directory = await temporaryDirectory();
        const file = join(directory, "array.json");
        await writeFile(file, "[1, 2]", "utf8");
        await assert.rejects(ResultFile.read(file), /must be a JSON object/);
    });
});

describe("ResultComparison", () => {
    /** A sample with 200 calls in the total and in each step, so that every percentile is measured. */
    function sampled(overrides: Partial<RunResult> = {}): RunResult {
        const base = sampleResult();
        return sampleResult({
            calls: 200,
            steps: base.steps.map((step) => ({ ...step, calls: 200 })),
            ...overrides,
        });
    }

    test("flags a latency rise above the threshold and not one below it", () => {
        const baseline = sampled();
        const candidate = sampled({ p95: 250, p50: 110 });
        const report = new ResultComparison(0.2).compare(baseline, candidate, "a.json", "b.json");
        const p95 = report.rows.find((row) => row.scope === "total" && row.metric === "p95");
        const p50 = report.rows.find((row) => row.scope === "total" && row.metric === "p50");
        assert.ok(p95 && p50);
        assert.equal(p95.regression, true, "25 % rise is over the 20 % threshold");
        assert.equal(p50.regression, false, "10 % rise is under the threshold");
        assert.ok(report.regressions >= 1);
    });

    test("a fall in latency is never a regression", () => {
        const report = new ResultComparison().compare(sampled(), sampled({ p99: 10 }), "a", "b");
        assert.equal(report.rows.find((row) => row.metric === "p99" && row.scope === "total")?.regression, false);
    });

    test("more errors than the baseline is a regression at any size", () => {
        const report = new ResultComparison().compare(sampled(), sampled({ errors: 1 }), "a", "b");
        const row = report.rows.find((item) => item.scope === "total" && item.metric === "errors");
        assert.equal(row?.regression, true);
    });

    test("steps are matched by name and steps that are missing on one side are left out", () => {
        const candidate = sampled({
            steps: [
                {
                    name: "2. second",
                    tool: "apply_operations",
                    calls: 200,
                    errors: 0,
                    bytes: 1,
                    p50: 110,
                    p95: 400,
                    p99: 1,
                    max: 1,
                },
            ],
        });
        const report = new ResultComparison().compare(sampled(), candidate, "a", "b");
        const scopes = new Set(report.rows.map((row) => row.scope));
        assert.deepEqual([...scopes].sort(), ["2. second", "total"]);
        assert.equal(report.rows.find((row) => row.scope === "2. second" && row.metric === "p95")?.regression, true);
    });

    test("a zero baseline has no percentage change and is not flagged", () => {
        const report = new ResultComparison().compare(sampleResult({ p50: 0 }), sampleResult({ p50: 50 }), "a", "b");
        const row = report.rows.find((item) => item.scope === "total" && item.metric === "p50");
        assert.equal(row?.changePct, null);
        assert.equal(row?.regression, false);
    });

    test("the text table names the regressions", () => {
        const report = new ResultComparison().compare(sampled(), sampled({ p95: 900 }), "base.json", "cand.json");
        const text = ResultComparison.format(report);
        assert.match(text, /baseline:\s+base\.json/);
        assert.match(text, /REGRESSION/);
        assert.match(text, /\d+ regression\(s\)/);
    });
});
