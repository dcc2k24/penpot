// Unit tests for the pure helpers of export-permit-report.mjs and export-permit-watch.mjs. Run with: node --test
// No network, no Redis, no child processes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    applyWindow,
    attemptStats,
    busyWaitSeconds,
    classifyFailure,
    concurrency,
    distribution,
    parseAdapterLog,
    parseMonitorLog,
    percentile,
    permitHolds,
    summarizeAdapter,
    summarizeMetrics,
    summarizeSamples,
} from "./export-permit-report.mjs";
import { sampleOf, selectMetricLines } from "./export-permit-watch.mjs";

const KEY = "penpot.mcp.export.permits";
const LEASE_MS = 65000;
const ESC = "\x1b";

/**
 * Builds one MONITOR log line the way the watcher writes it.
 *
 * @param {string} time - the time Redis gave
 * @param {string[]} args - the command and its arguments
 * @returns {string} the tab separated line
 */
function monitorLine(time, args) {
    return [time, "127.0.0.1:50000", "0", JSON.stringify(args)].join("\t");
}

/**
 * Builds a take record for permitHolds.
 *
 * @param {string} member - the member id
 * @param {number} atMs - the take time
 * @param {number} [lease] - the lease in ms
 * @returns {{member: string, atMs: number, expiresAtMs: number}} the take
 */
function take(member, atMs, lease = LEASE_MS) {
    return { member, atMs, expiresAtMs: atMs + lease };
}

test("percentile uses nearest rank on one, two and twenty values", () => {
    assert.equal(percentile([5], 0.5), 5);
    assert.equal(percentile([5], 0.95), 5);
    assert.equal(percentile([1, 2], 0.5), 1);
    assert.equal(percentile([1, 2], 0.95), 2);
    const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
    assert.equal(percentile(twenty, 0.5), 10);
    assert.equal(percentile(twenty, 0.95), 19);
    assert.equal(percentile(twenty, 0), 1);
    assert.equal(percentile([], 0.5), null);
});

test("distribution sorts a copy and gives null fields for an empty list", () => {
    assert.deepEqual(distribution([2, 1]), { count: 2, min: 1, p50: 1, p95: 2, max: 2 });
    assert.deepEqual(distribution([5]), { count: 1, min: 5, p50: 5, p95: 5, max: 5 });
    const twenty = Array.from({ length: 20 }, (_, index) => 20 - index);
    assert.deepEqual(distribution(twenty), { count: 20, min: 1, p50: 10, p95: 19, max: 20 });
    assert.deepEqual(distribution([]), { count: 0, min: null, p50: null, p95: null, max: null });
});

test("parseMonitorLog reads takes, releases and attempts and skips broken lines", () => {
    const text = [
        monitorLine("1762676862.100000", ["evalsha", "sha1", "1", KEY, "m1", "4", String(LEASE_MS)]),
        monitorLine("1762676862.100000", ["zadd", KEY, "1762676927100", "m1"]),
        monitorLine("1762676863.000000", ["zrem", KEY, "m1"]),
        monitorLine("1762676863.500000", ["evalsha", "sha1", "1", KEY, "m2", "4", String(LEASE_MS)]),
        monitorLine("1762676863.600000", ["zadd", "some.other.key", "1", "x"]),
        "not a monitor line",
        "1762676863.700000\t127.0.0.1:1\t0\t[not json",
        "",
    ].join("\n");
    const parsed = parseMonitorLog(text, KEY);
    assert.deepEqual(parsed.takes, [{ member: "m1", atMs: 1762676862100, expiresAtMs: 1762676927100 }]);
    assert.deepEqual(parsed.releases, [{ member: "m1", atMs: 1762676863000 }]);
    assert.deepEqual(parsed.attempts, [
        { member: "m1", atMs: 1762676862100 },
        { member: "m2", atMs: 1762676863500 },
    ]);
    assert.equal(parsed.skipped, 2);
    assert.equal(parsed.firstMs, 1762676862100);
    assert.equal(parsed.lastMs, 1762676863500);
    assert.deepEqual(attemptStats(parsed), { attempts: 2, granted: 1, refusedPolls: 1 });
});

test("permitHolds: a release in time is a normal hold", () => {
    const events = { takes: [take("m1", 1000)], releases: [{ member: "m1", atMs: 5000 }], lastMs: 10000 };
    const result = permitHolds(events, LEASE_MS);
    assert.equal(result.holds[0].holdMs, 4000);
    assert.equal(result.holds[0].expiredBeforeRelease, false);
    assert.equal(result.exceededLease, 0);
    assert.equal(result.heldAtEnd, 0);
    assert.equal(result.leaseMismatch, 0);
    assert.deepEqual(result.leaseValues, [LEASE_MS]);
});

test("permitHolds: a release after the expiry counts as exceeding the lease", () => {
    const events = { takes: [take("m2", 1000)], releases: [{ member: "m2", atMs: 70000 }], lastMs: 80000 };
    const result = permitHolds(events, LEASE_MS);
    assert.equal(result.holds[0].expiredBeforeRelease, true);
    assert.equal(result.exceededLease, 1);
});

test("permitHolds: never released and the recording went on past the expiry", () => {
    const events = { takes: [take("m3", 1000)], releases: [], lastMs: 70000 };
    const result = permitHolds(events, LEASE_MS);
    assert.equal(result.holds[0].releasedAtMs, null);
    assert.equal(result.holds[0].holdMs, null);
    assert.equal(result.holds[0].expiredBeforeRelease, true);
    assert.equal(result.exceededLease, 1);
    assert.equal(result.heldAtEnd, 0);
});

test("permitHolds: never released and the recording stopped before the expiry is held at the end", () => {
    const events = { takes: [take("m4", 1000)], releases: [], lastMs: 10000 };
    const result = permitHolds(events, LEASE_MS);
    assert.equal(result.holds[0].expiredBeforeRelease, false);
    assert.equal(result.exceededLease, 0);
    assert.equal(result.heldAtEnd, 1);
});

test("permitHolds: a lease within 5 ms of the configured lease is not a mismatch", () => {
    const near = permitHolds({ takes: [take("near", 1000, 64998)], releases: [], lastMs: 3000 }, LEASE_MS);
    assert.equal(near.leaseMismatch, 0);
    const far = permitHolds({ takes: [take("far", 1000, 60000)], releases: [], lastMs: 3000 }, LEASE_MS);
    assert.equal(far.leaseMismatch, 1);
});

test("permitHolds pairs a member taken again with the right release", () => {
    const events = {
        takes: [take("same", 1000), take("same", 3000)],
        releases: [{ member: "same", atMs: 2000 }],
        lastMs: 4000,
    };
    const result = permitHolds(events, LEASE_MS);
    assert.equal(result.holds[0].releasedAtMs, 2000);
    assert.equal(result.holds[1].releasedAtMs, null);
});

test("concurrency: two overlapping holds give a peak of two and the time at each level", () => {
    const events = {
        takes: [take("a", 0, 100), take("b", 5, 100)],
        releases: [
            { member: "a", atMs: 10 },
            { member: "b", atMs: 15 },
        ],
        lastMs: 15,
    };
    const { holds } = permitHolds(events, 100);
    assert.deepEqual(concurrency(holds, 15), { max: 2, msAt: { 1: 10, 2: 5 } });
    assert.deepEqual(concurrency(holds, 20), { max: 2, msAt: { 0: 5, 1: 10, 2: 5 } });
    assert.deepEqual(concurrency([], 20), { max: 0, msAt: {} });
});

test("concurrency: a release is counted before a take at the same time", () => {
    const holds = [
        { takenAtMs: 0, releasedAtMs: 10, leaseMs: 100 },
        { takenAtMs: 10, releasedAtMs: 20, leaseMs: 100 },
    ];
    assert.deepEqual(concurrency(holds, 20), { max: 1, msAt: { 1: 20 } });
});

test("applyWindow keeps only the events inside the window and clips the first and last times", () => {
    const parsed = parseMonitorLog(
        [
            monitorLine("100.000000", ["zadd", KEY, "165000", "a"]),
            monitorLine("200.000000", ["zadd", KEY, "265000", "b"]),
        ].join("\n"),
        KEY
    );
    const inside = applyWindow(parsed, { from: 150000, to: 300000 });
    assert.deepEqual(
        inside.takes.map((item) => item.member),
        ["b"]
    );
    assert.equal(inside.firstMs, 150000);
    assert.equal(inside.lastMs, 200000);
});

test("summarizeSamples counts histograms, peaks, cap and expired members, and error lines apart", () => {
    const lines = [
        { t: "2026-11-09T10:00:00.000Z", redisMs: 1000, zcard: 1, live: 1, members: [["a", 2000]] },
        {
            t: "2026-11-09T10:00:01.000Z",
            redisMs: 1000,
            zcard: 3,
            live: 2,
            members: [
                ["a", 2000],
                ["b", 500],
                ["c", 3000],
            ],
        },
        { t: "2026-11-09T10:00:02.000Z", error: "connection refused" },
        {
            t: "2026-11-09T10:00:03.000Z",
            redisMs: 1000,
            zcard: 5,
            live: 5,
            members: [
                ["d", 9000],
                ["e", 9000],
                ["f", 9000],
                ["g", 9000],
                ["h", 9000],
            ],
        },
    ];
    const summary = summarizeSamples(lines, 4);
    assert.equal(summary.samples, 3);
    assert.equal(summary.errors, 1);
    assert.deepEqual(summary.zcardHistogram, { 1: 1, 3: 1, 5: 1 });
    assert.deepEqual(summary.liveHistogram, { 1: 1, 2: 1, 5: 1 });
    assert.equal(summary.maxZcard, 5);
    assert.equal(summary.maxLive, 5);
    assert.equal(summary.aboveCap, 1);
    assert.equal(summary.withExpiredMember, 1);
    assert.equal(summary.firstT, "2026-11-09T10:00:00.000Z");
});

test("sampleOf and selectMetricLines from the watcher", () => {
    const sample = sampleOf(["1000", "500000"], ["a", "1002000", "b", "900000"], "2026-11-09T10:00:00.000Z");
    assert.equal(sample.redisMs, 1000500);
    assert.equal(sample.zcard, 2);
    assert.equal(sample.live, 1);
    assert.deepEqual(sample.members, [
        ["a", 1002000],
        ["b", 900000],
    ]);
    const kept = selectMetricLines(
        [
            "# HELP penpot_mcp_redis_up whether redis answers",
            "penpot_mcp_redis_up 1",
            "",
            'penpot_mcp_tool_calls_total{tool="export_shape",outcome="ok"} 4',
            'penpot_mcp_tool_calls_total{tool="get_page_tree"} 9',
            "some_other_metric 3",
        ].join("\n")
    );
    assert.deepEqual(kept, [
        "penpot_mcp_redis_up 1",
        'penpot_mcp_tool_calls_total{tool="export_shape",outcome="ok"} 4',
    ]);
});

test("parseAdapterLog reads coloured calls and failures, and ignores stack lines", () => {
    const text = [
        `${ESC}[32mINFO${ESC}[39m ${ESC}[90m[2026-11-08 08:27:42.568]${ESC}[39m (PenpotMcpServer): Tool call finished`,
        '    tool: "export_shape"',
        '    requestId: "beb21441-0a2d-446e-97ef-4f5cc0b11800"',
        "    durationMs: 5933",
        '    outcome: "ok"',
        "INFO [2026-11-09 08:40:01.123] (Tool): Tool execution #12 refused: export_shape request=1234-abcd; " +
            "reason: Error: export is busy, retry later: no slot was free for 30 seconds.",
        "ERROR [2026-11-09 08:41:00.000] (Tool): Tool execution #13 failed: export_shape request=ffff-0000; " +
            "error: ExporterError: The exporter failed to render the shape: ResourceRequest timed out",
        "    at render (/app/file.js:1:2)",
        "    at other (/app/x.js:3:4)",
    ].join("\n");
    const parsed = parseAdapterLog(text);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].tool, "export_shape");
    assert.equal(parsed.calls[0].durationMs, 5933);
    assert.equal(parsed.calls[0].outcome, "ok");
    assert.deepEqual(parsed.calls[0].at, new Date(2026, 10, 8, 8, 27, 42, 568));
    assert.equal(parsed.failures.length, 2);
    assert.deepEqual(parsed.failures[0], {
        at: new Date(2026, 10, 9, 8, 40, 1, 123),
        tool: "export_shape",
        kind: "refused",
        text: "Error: export is busy, retry later: no slot was free for 30 seconds.",
    });
    assert.equal(parsed.failures[1].kind, "failed");
    assert.equal(
        parsed.failures[1].text,
        "ExporterError: The exporter failed to render the shape: ResourceRequest timed out"
    );
});

test("classifyFailure checks busy, then render timeout, then exporter", () => {
    assert.equal(classifyFailure("Error: export is busy, retry later: no slot was free for 30 seconds."), "busy");
    assert.equal(classifyFailure("The export did not finish within 60 seconds."), "render-timeout");
    assert.equal(classifyFailure("The exporter failed to render the shape"), "exporter");
    assert.equal(classifyFailure("something else"), "other");
});

test("busyWaitSeconds reads the wait or gives null", () => {
    assert.equal(busyWaitSeconds("no slot was free for 30 seconds."), 30);
    assert.equal(busyWaitSeconds("no slot was free for 2.5 seconds"), 2.5);
    assert.equal(busyWaitSeconds("The exporter failed"), null);
});

test("summarizeAdapter keeps only the calls and failures inside the window and of the tool", () => {
    const parsed = {
        calls: [
            { at: new Date(2026, 10, 8, 8, 0), tool: "export_shape", durationMs: 1000, outcome: "ok" },
            { at: new Date(2026, 10, 9, 9, 0), tool: "export_shape", durationMs: 70000, outcome: "error" },
            { at: new Date(2026, 10, 9, 9, 5), tool: "get_page_tree", durationMs: 50, outcome: "ok" },
        ],
        failures: [
            {
                at: new Date(2026, 10, 8, 8, 1),
                tool: "export_shape",
                kind: "refused",
                text: "export is busy, retry later: no slot was free for 10 seconds.",
            },
            {
                at: new Date(2026, 10, 9, 9, 1),
                tool: "export_shape",
                kind: "refused",
                text: "export is busy, retry later: no slot was free for 30 seconds.",
            },
        ],
    };
    const summary = summarizeAdapter(
        parsed,
        "export_shape",
        new Date(2026, 10, 9, 0, 0),
        new Date(2026, 10, 9, 23, 59)
    );
    assert.equal(summary.calls, 1);
    assert.equal(summary.ok, 0);
    assert.equal(summary.error, 1);
    assert.equal(summary.atLeast60s, 1);
    assert.equal(summary.failures.busy, 1);
    assert.deepEqual(summary.busyWaitSeconds, { count: 1, min: 30, p50: 30, p95: 30, max: 30 });
    assert.deepEqual(summary.distinctFailureTexts, ["export is busy, retry later: no slot was free for 30 seconds."]);

    const everything = summarizeAdapter(parsed, "export_shape", null, null);
    assert.equal(everything.calls, 2);
    assert.equal(everything.ok, 1);
});

test("summarizeMetrics gives the fallback increase, null for missing series and counts failed scrapes", () => {
    const entries = [
        {
            t: "2026-11-09T10:00:00.000Z",
            adapter: "http://127.0.0.1:4406/metrics",
            ok: true,
            lines: [
                "penpot_mcp_export_permit_fallback_total 2",
                "penpot_mcp_redis_up 1",
                'penpot_mcp_redis_client_up{client="export-permits"} 1',
                "nodejs_eventloop_lag_p99_seconds 0.01",
                "process_resident_memory_bytes 1048576",
                "penpot_mcp_render_sessions 2",
            ],
        },
        { t: "2026-11-09T10:00:05.000Z", adapter: "http://127.0.0.1:4406/metrics", ok: false, error: "HTTP 500" },
        {
            t: "2026-11-09T10:00:10.000Z",
            adapter: "http://127.0.0.1:4406/metrics",
            ok: true,
            lines: [
                'penpot_mcp_export_permit_fallback_total{reason="a"} 3',
                'penpot_mcp_export_permit_fallback_total{reason="b"} 4',
                "penpot_mcp_redis_up 0",
                "nodejs_eventloop_lag_p99_seconds 0.05",
                "process_resident_memory_bytes 2097152",
                "penpot_mcp_render_sessions 1",
            ],
        },
        {
            t: "2026-11-09T10:00:00.000Z",
            adapter: "http://127.0.0.1:4407/metrics",
            ok: true,
            lines: ["penpot_mcp_redis_up 1"],
        },
    ];
    const summary = summarizeMetrics(entries);
    const first = summary["http://127.0.0.1:4406/metrics"];
    assert.equal(first.scrapes, 3);
    assert.equal(first.failedScrapes, 1);
    assert.equal(first.fallbackFirst, 2);
    assert.equal(first.fallbackLast, 7);
    assert.equal(first.fallbackIncrease, 5);
    assert.equal(first.redisUpMin, 0);
    assert.equal(first.exportPermitsClientUpMin, 1);
    assert.equal(first.eventLoopLagP99Max, 0.05);
    assert.equal(first.residentBytesMax, 2097152);
    assert.equal(first.renderSessionsMax, 2);

    const second = summary["http://127.0.0.1:4407/metrics"];
    assert.equal(second.fallbackFirst, null);
    assert.equal(second.fallbackIncrease, null);
    assert.equal(second.exportPermitsClientUpMin, null);
    assert.equal(second.redisUpMin, 1);
});
