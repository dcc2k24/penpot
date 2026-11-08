// Unit tests for the pure helpers of export-capacity.mjs. Run with: node --test
// No network, no child processes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    assertResult,
    buildCommand,
    classifyError,
    formatReport,
    parseCount,
    pickLatest,
    quoteArg,
    redact,
    runArgs,
    summarizeRun,
} from "./export-capacity.mjs";

/** A result document shaped per src/ResultFile.ts, for the export run. */
function exportResult(overrides = {}) {
    return {
        schemaVersion: 2,
        scenario: "C8-export-heavy",
        description: "test",
        commit: "abc",
        startedAt: "2026-11-07T10:00:00.000Z",
        finishedAt: "2026-11-07T10:03:00.000Z",
        durationMs: 180000,
        agents: 10,
        iterations: 10,
        rateLimitPerSecond: null,
        machineSpec: {
            platform: "win32",
            arch: "x64",
            cpuModel: "x",
            cpuCores: 8,
            totalMemoryBytes: 1,
            nodeVersion: "v24",
        },
        calls: 200,
        errors: 5,
        bytes: 0,
        p50: 900,
        p95: 2400,
        p99: 3100,
        max: 4000,
        heap: { startBytes: 1, endBytes: 1, peakBytes: 1 },
        rss: { startBytes: 1, endBytes: 1, peakBytes: 1 },
        steps: [
            {
                name: "1. export board png 2x",
                tool: "export_shape",
                calls: 200,
                errors: 5,
                bytes: 0,
                p50: 950,
                p95: 2500,
                p99: 3000,
                max: 4000,
            },
        ],
        errorSamples: [
            "The export did not finish within 60 seconds.",
            "The exporter rejected the export request",
            "setup: could not create the board",
            "Something else went wrong",
        ],
        warnings: [],
        ...overrides,
    };
}

/** A result document for the read run, with two read steps. */
function readResult() {
    return exportResult({
        scenario: "C8-export-heavy-reads",
        agents: 3,
        calls: 90,
        errors: 0,
        p50: 40,
        p95: 120,
        steps: [
            {
                name: "1. page tree",
                tool: "get_page_tree",
                calls: 45,
                errors: 0,
                bytes: 0,
                p50: 35,
                p95: 90,
                p99: 100,
                max: 150,
            },
            {
                name: "2. find frames",
                tool: "find_shapes",
                calls: 45,
                errors: 0,
                bytes: 0,
                p50: 45,
                p95: 130,
                p99: 140,
                max: 160,
            },
        ],
        errorSamples: [],
    });
}

test("classifyError maps the export permit text", () => {
    assertEqualCategory("export permit timed out waiting", "export permit");
    assertEqualCategory("Waiting for an EXPORT PERMIT", "export permit");
});

test("classifyError maps the render deadline text to render timeout", () => {
    assertEqualCategory("The export did not finish within 60 seconds.", "render timeout");
});

test("classifyError maps exporter messages", () => {
    assertEqualCategory("The exporter could not find the shape or file", "exporter");
});

test("classifyError maps setup messages and everything else", () => {
    assertEqualCategory("setup: could not create the board", "setup");
    assertEqualCategory("Something else went wrong", "other");
    assertEqualCategory(undefined, "other");
});

function assertEqualCategory(message, expected) {
    assert.equal(classifyError(message), expected, `message: ${message}`);
}

test("summarizeRun reads export step figures, error groups and matches", () => {
    const run = summarizeRun(exportResult());
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0].tool, "export_shape");
    assert.equal(run.steps[0].p50, 950);
    assert.equal(run.steps[0].p95, 2500);
    assert.equal(run.errors, 5);
    assert.equal(run.errorSampleCount, 4);
    assert.deepEqual(run.errorGroups["render timeout"], ["The export did not finish within 60 seconds."]);
    assert.deepEqual(run.errorGroups.exporter, ["The exporter rejected the export request"]);
    assert.deepEqual(run.errorGroups.setup, ["setup: could not create the board"]);
    assert.deepEqual(run.errorGroups.other, ["Something else went wrong"]);
    assert.equal(run.exportPermitMatches, 0);
    assert.equal(run.exporterMatches, 1);
    assert.equal(run.readP95, null);
});

test("summarizeRun counts export permit matches separately from exporter matches", () => {
    const run = summarizeRun(
        exportResult({
            errorSamples: ["export permit wait failed", "Exporter: export permit lost", "The exporter is down"],
        })
    );
    assert.equal(run.exportPermitMatches, 2);
    assert.equal(run.exporterMatches, 2);
    assert.equal(run.errorGroups["export permit"].length, 2);
});

test("summarizeRun uses the run-level p95 as the read p95 for a read-only run", () => {
    const run = summarizeRun(readResult());
    assert.equal(run.readP95, 120);
    assert.deepEqual(
        run.steps.map((step) => [step.tool, step.p95]),
        [
            ["get_page_tree", 90],
            ["find_shapes", 130],
        ]
    );
    assert.equal(run.steps.filter((step) => step.tool === "export_shape").length, 0);
});

test("summarizeRun tolerates a result with no error samples", () => {
    const run = summarizeRun(readResult());
    assert.equal(run.errorSampleCount, 0);
    assert.equal(run.exportPermitMatches, 0);
    assert.equal(run.exporterMatches, 0);
});

test("assertResult accepts a valid result and rejects a broken one", () => {
    assert.doesNotThrow(() => assertResult(exportResult(), "ok.json"));
    assert.throws(() => assertResult({ scenario: "x" }, "bad.json"), /bad\.json is not a valid result/);
    assert.throws(() => assertResult(null, "null.json"), /must be a JSON object/);
});

test("pickLatest chooses the newest result per scenario", () => {
    const older = { file: "old.json", result: exportResult({ startedAt: "2026-11-06T10:00:00.000Z" }) };
    const newer = { file: "new.json", result: exportResult({ startedAt: "2026-11-07T10:00:00.000Z" }) };
    const reads = { file: "reads.json", result: readResult() };
    const picked = pickLatest([older, reads, newer]);
    assert.equal(picked.exportEntry.file, "new.json");
    assert.equal(picked.readEntry.file, "reads.json");
});

test("formatReport prints both runs, the step p95 and the error groups", () => {
    const text = formatReport({
        exportEntry: { file: "export.json", result: exportResult() },
        readEntry: { file: "reads.json", result: readResult() },
    });
    assert.match(text, /Export run C8-export-heavy/);
    assert.match(text, /export_shape\): calls 200, errors 5, p50 950\.0 ms, p95 2500\.0 ms/);
    assert.match(text, /render timeout: 1/);
    assert.match(text, /messages matching \/export permit\/i: 0/);
    assert.match(text, /messages matching \/exporter\/i: 1/);
    assert.match(text, /read p95 across both read steps: 120\.0 ms/);
});

test("formatReport says when a result file is missing", () => {
    const text = formatReport({ exportEntry: undefined, readEntry: undefined });
    assert.match(text, /Export run C8-export-heavy: no result file found/);
    assert.match(text, /Read run C8-export-heavy-reads: no result file found/);
});

test("runArgs builds the run arguments in order", () => {
    const args = runArgs({
        scenario: "C8-export-heavy",
        url: "http://localhost:4401/mcp",
        tokensFile: "/t/tokens.txt",
        varsFile: "/t/vars.json",
        agents: 10,
        duration: "3m",
        resultsDir: "/r",
    });
    assert.deepEqual(args, [
        "run",
        "C8-export-heavy",
        "--url",
        "http://localhost:4401/mcp",
        "--tokens",
        "/t/tokens.txt",
        "--vars",
        "/t/vars.json",
        "--agents",
        "10",
        "--duration",
        "3m",
        "--results",
        "/r",
    ]);
});

test("quoteArg quotes paths with spaces and rejects double quotes", () => {
    assert.equal(quoteArg("plain-arg_1"), "plain-arg_1");
    assert.equal(quoteArg("C:\\Program Files\\x.json"), '"C:\\Program Files\\x.json"');
    assert.throws(() => quoteArg('a"b'), /double quote/);
});

test("buildCommand starts with the pnpm loadtest alias", () => {
    const command = buildCommand(["run", "C8-export-heavy-reads", "--duration", "3m"]);
    assert.equal(command, "npx pnpm loadtest run C8-export-heavy-reads --duration 3m");
});

test("redact hides token values", () => {
    assert.equal(redact("key abc123 and xyz", ["abc123", "xyz"]), "key <token> and <token>");
    assert.equal(redact("nothing here", []), "nothing here");
});

test("parseCount accepts whole numbers of at least one only", () => {
    assert.equal(parseCount(undefined, "--x", 7), 7);
    assert.equal(parseCount("4", "--x", 7), 4);
    assert.throws(() => parseCount("0", "--x", 7), /--x must be a whole number/);
    assert.throws(() => parseCount("2.5", "--x", 7), /--x must be/);
    assert.throws(() => parseCount("abc", "--x", 7), /--x must be/);
});
