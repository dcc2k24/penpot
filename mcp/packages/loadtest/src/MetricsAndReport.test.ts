import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MetricsSampler } from "./Metrics.js";
import { HtmlReport, summaryLines } from "./Report.js";
import { sampleResult } from "./testing/SampleResult.js";

/** Backend figures of a run that watched everything. Sizes are whole mebibytes, so the lines are easy to check. */
const WATCHED = sampleResult({
    calls: 20,
    durationMs: 10_000,
    backendHeap: {
        startBytes: 1024 * 1024,
        endBytes: 3 * 1024 * 1024,
        peakBytes: 4 * 1024 * 1024,
        maxBytes: 8 * 1024 * 1024,
    },
    gc: { seconds: 1.5, collections: 7 },
    backendCpuSeconds: 5,
    backendRequests: 40,
    mcpCommands: 20,
    connectionCheckouts: 30,
    dbStatements: 100,
    dbStatementsSource: "metrics",
    pg: {
        transactions: 4,
        tableScans: 60,
        rowsRead: 500,
        rowsWritten: 40,
        fileChangeSeqScans: 2,
        fileChangeIdxScans: 9,
    },
    serverRss: {
        startBytes: 10 * 1024 * 1024,
        endBytes: 12 * 1024 * 1024,
        peakBytes: 15 * 1024 * 1024,
    },
    warnings: ["postgres stats failed: boom"],
});

const SCRAPE_BEFORE = `# HELP penpot_mcp_errors_total Errors.
# TYPE penpot_mcp_errors_total counter
penpot_mcp_errors_total{tool="apply_operations",code="validation"} 2
penpot_mcp_errors_total{tool="whoami",code="auth"} 1
penpot_db_statements_total 100
penpot_mcp_tool_duration_seconds_bucket{tool="whoami",le="0.1"} 5
jvm_threads_live 40
`;

const SCRAPE_AFTER = `penpot_mcp_errors_total{tool="apply_operations",code="validation"} 4
penpot_mcp_errors_total{tool="whoami",code="auth"} 1
penpot_db_statements_total 340
penpot_mcp_tool_duration_seconds_bucket{tool="whoami",le="0.1"} 9
jvm_threads_live 41
`;

const JVM_SCRAPE = `# HELP jvm_memory_bytes_used Used bytes.
# TYPE jvm_memory_bytes_used gauge
jvm_memory_bytes_used{area="heap",id="G1 Eden Space"} 1234
jvm_memory_bytes_used{area="heap",id="G1 Old Gen"} 5000
jvm_memory_bytes_used{area="nonheap",id="Metaspace"} 99999
jvm_memory_bytes_max{area="heap"} 8589934592
jvm_gc_collection_seconds_sum{gc="G1 Young Generation"} 1.5
jvm_gc_collection_seconds_sum{gc="G1 Old Generation"} 0.25
jvm_gc_collection_seconds_count{gc="G1 Young Generation"} 12
jvm_gc_collection_seconds_count{gc="G1 Old Generation"} 1
process_cpu_seconds_total 42.5
hikaricp_connection_usage_millis_count{pool="HikariPool-1"} 300
hikaricp_connection_usage_millis_count{pool="HikariPool-2"} 50
penpot_rpc_main_timing_count{name="get-file"} 7
penpot_rpc_main_timing_count{name="update-file"} 3
penpot_mcp_tool_duration_seconds_count{tool="whoami",outcome="ok"} 4
penpot_mcp_tool_duration_seconds_count{tool="apply_operations",outcome="error"} 2
jvm_threads_live 60
penpot_not_a_number NaN
`;

describe("MetricsSampler", () => {
    test("parseSeries keys each sample by its name and label block and skips comments and NaN", () => {
        const series = MetricsSampler.parseSeries(JVM_SCRAPE);
        assert.equal(series['jvm_memory_bytes_used{area="heap",id="G1 Eden Space"}'], 1234);
        assert.equal(series["process_cpu_seconds_total"], 42.5);
        assert.equal(series["jvm_threads_live"], 60);
        assert.equal(
            Object.keys(series).some((key) => key.startsWith("#")),
            false
        );
        assert.equal(
            Object.keys(series).some((key) => key.startsWith("penpot_not_a_number")),
            false
        );
    });

    test("jvmFigures sums the collectors and pools and reads the heap series", () => {
        const figures = MetricsSampler.jvmFigures(MetricsSampler.parseSeries(JVM_SCRAPE));
        assert.equal(figures.heapUsedBytes, 6234, "non-heap memory is left out");
        assert.equal(figures.heapMaxBytes, 8589934592);
        assert.equal(figures.gcSeconds, 1.75);
        assert.equal(figures.gcCount, 13);
        assert.equal(figures.cpuSeconds, 42.5);
        assert.equal(figures.connectionCheckouts, 350);
        assert.equal(figures.backendRequests, 10);
        assert.equal(figures.mcpCommands, 6);
    });

    test("jvmFigures leaves a field undefined when its series is missing", () => {
        const empty = MetricsSampler.jvmFigures({});
        assert.equal(empty.heapUsedBytes, undefined);
        assert.equal(empty.mcpCommands, undefined);
        const nonHeapOnly = MetricsSampler.jvmFigures({ 'jvm_memory_bytes_used{area="nonheap"}': 5 });
        assert.equal(nonHeapOnly.heapUsedBytes, undefined);
    });

    test("scrape returns the raw text and sample parses the same body", async () => {
        const sampler = new MetricsSampler("http://127.0.0.1:1/metrics", async () => new Response(JVM_SCRAPE));
        assert.equal(await sampler.scrape(), JVM_SCRAPE);
        assert.equal((await sampler.sample()).penpot_rpc_main_timing_count, 10);
    });

    test("parses Prometheus text and sums the label sets of each metric", () => {
        const totals = MetricsSampler.parse(SCRAPE_BEFORE);
        assert.equal(totals.penpot_mcp_errors_total, 3);
        assert.equal(totals.penpot_db_statements_total, 100);
        assert.equal(totals.jvm_threads_live, 40);
    });

    test("delta keeps only penpot counters that moved and leaves out histogram buckets", () => {
        const delta = MetricsSampler.delta(MetricsSampler.parse(SCRAPE_BEFORE), MetricsSampler.parse(SCRAPE_AFTER));
        assert.deepEqual(delta, { penpot_mcp_errors_total: 2, penpot_db_statements_total: 240 });
    });

    test("the statement count is picked out of the delta", () => {
        assert.equal(MetricsSampler.dbStatements({ penpot_db_statements_total: 240, penpot_mcp_errors_total: 2 }), 240);
        assert.equal(MetricsSampler.dbStatements({ penpot_mcp_errors_total: 2 }), undefined);
    });

    test("a failed scrape is an error", async () => {
        const sampler = new MetricsSampler("http://127.0.0.1:1/metrics", async () => new Response("", { status: 503 }));
        await assert.rejects(sampler.sample(), /answered HTTP 503/);
    });
});

describe("HtmlReport", () => {
    test("renders a self-contained page with the tables and no external resources", () => {
        const html = HtmlReport.render(
            sampleResult({ scenario: "S1 <pages>", errorSamples: ["boom & bust"], warnings: ["metrics down"] })
        );
        assert.match(html, /^<!doctype html>/);
        assert.match(html, /S1 &lt;pages&gt;/, "scenario name is escaped");
        assert.match(html, /boom &amp; bust/);
        assert.match(html, /<h2>Steps<\/h2>/);
        assert.match(html, /<td><code>apply_operations<\/code><\/td>/);
        assert.doesNotMatch(html, /<script/i);
        assert.doesNotMatch(html, /https?:\/\//i, "no CDN or other external link");
        assert.doesNotMatch(html, /<link /i);
    });

    test("adds the comparison table when one is given", () => {
        const baseline = sampleResult({ scenario: "base" });
        const candidate = sampleResult({ scenario: "cand", p95: 900 });
        const report = {
            baseline: "base.json",
            candidate: "cand.json",
            threshold: 0.2,
            rows: [
                {
                    scope: "total",
                    metric: "p95",
                    baseline: baseline.p95,
                    candidate: candidate.p95,
                    changePct: 3.5,
                    regression: true,
                },
            ],
            regressions: 1,
        };
        const html = HtmlReport.render(candidate, report);
        assert.match(html, /Compared with base\.json/);
        assert.match(html, /REGRESSION/);
    });

    test("shows the Backend table when the run watched the backend", () => {
        const html = HtmlReport.render(sampleResult({ backendRequests: 12, backendHeap: WATCHED.backendHeap }));
        assert.match(html, /<h2>Backend<\/h2>/);
        assert.match(html, /<dt>Backend requests<\/dt><dd>12<\/dd>/);
        assert.match(html, /<dt>Heap<\/dt><dd>start 1\.0 MB, peak 4\.0 MB, end 3\.0 MB, max 8\.0 MB<\/dd>/);
        assert.doesNotMatch(html, /https?:\/\//i, "no external link");
    });

    test("leaves the Backend table out when the run watched nothing", () => {
        assert.doesNotMatch(HtmlReport.render(sampleResult()), /<h2>Backend<\/h2>/);
    });
});

describe("summaryLines", () => {
    test("prints every figure in order, with per-call values and cores", () => {
        assert.deepEqual(summaryLines(WATCHED), [
            "backend heap: start 1.0 MB, peak 4.0 MB, end 3.0 MB, max 8.0 MB",
            "backend gc: 7 collections, 1.5 s; cpu 5.0 s (0.5 cores on average)",
            "backend requests 40, mcp commands 20, pool checkouts 30 (1.5 per call)",
            "db statements 100 (5.0 per call, from metrics)",
            "db table scans 60 (3.0 per call), rows read 500, rows written 40 (2.0 per call), " +
                "transactions 4 (0.2 per call), file_change seq scans 2, index scans 9",
            "mcp server rss: start 10.0 MB, peak 15.0 MB, end 12.0 MB",
            "warning: postgres stats failed: boom",
        ]);
    });

    test("says the statements were not counted when Postgres has no statement count", () => {
        const lines = summaryLines(sampleResult({ pg: WATCHED.pg }));
        assert.ok(lines.includes("db statements: not counted (pg_stat_statements is not loaded)"), lines.join("\n"));
        assert.equal(
            lines.some((line) => line.startsWith("db statements ")),
            false
        );
    });

    test("prints no backend line for a run that watched nothing", () => {
        assert.deepEqual(summaryLines(sampleResult()), []);
    });

    test("shows n/a instead of dividing by zero", () => {
        const lines = summaryLines(
            sampleResult({ calls: 0, durationMs: 0, backendCpuSeconds: 1, connectionCheckouts: 3, dbStatements: 5 })
        );
        assert.ok(lines.includes("backend cpu: 1.0 s (n/a cores on average)"), lines.join("\n"));
        assert.ok(lines.includes("pool checkouts 3 (n/a per call)"), lines.join("\n"));
        assert.ok(lines.includes("db statements 5 (n/a per call, from unknown source)"), lines.join("\n"));
    });
});
