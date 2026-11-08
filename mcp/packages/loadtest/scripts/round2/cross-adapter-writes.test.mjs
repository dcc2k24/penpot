// Unit tests for the pure helpers of cross-adapter-writes.mjs. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    checkPresence,
    checkRevnOrder,
    createPacer,
    isBusyError,
    nameFor,
    parseArgs,
    percentile,
    planSequence,
    summarizeLane,
} from "./cross-adapter-writes.mjs";

test("percentile uses nearest rank on unsorted values", () => {
    const values = [9, 1, 10, 3, 7, 2, 8, 4, 6, 5];
    assert.equal(percentile(values, 50), 5);
    assert.equal(percentile(values, 95), 10);
    assert.equal(percentile(values, 10), 1);
    assert.equal(percentile([42], 95), 42);
});

test("percentile of no samples is null", () => {
    assert.equal(percentile([], 50), null);
});

test("percentile does not reorder the input", () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    assert.deepEqual(values, [3, 1, 2]);
});

test("nameFor pads the sequence number to 4 digits", () => {
    assert.equal(nameFor(0), "xa-seq-0000");
    assert.equal(nameFor(7), "xa-seq-0007");
    assert.equal(nameFor(199), "xa-seq-0199");
});

test("isBusyError matches the mcp-file-busy code and nothing else", () => {
    assert.equal(isBusyError('Tool execution failed: {"code":"mcp-file-busy"}'), true);
    assert.equal(isBusyError("mcp-lock-timeout"), false);
    assert.equal(isBusyError(undefined), false);
});

test("checkRevnOrder accepts strictly increasing revn values", () => {
    const result = checkRevnOrder([
        { seq: 0, revn: 5 },
        { seq: 1, revn: 6 },
        { seq: 2, revn: 7 },
    ]);
    assert.equal(result.strictlyIncreasing, true);
    assert.deepEqual(result.duplicates, []);
    assert.equal(result.seqOrderMatches, true);
    assert.equal(result.count, 3);
});

test("checkRevnOrder sorts by revn before checking", () => {
    const result = checkRevnOrder([
        { seq: 1, revn: 7 },
        { seq: 0, revn: 5 },
        { seq: 2, revn: 6 },
    ]);
    assert.equal(result.strictlyIncreasing, true);
    assert.equal(result.seqOrderMatches, false);
});

test("checkRevnOrder reports duplicate revn values", () => {
    const result = checkRevnOrder([
        { seq: 0, revn: 5 },
        { seq: 1, revn: 5 },
        { seq: 2, revn: 6 },
    ]);
    assert.equal(result.strictlyIncreasing, false);
    assert.deepEqual(result.duplicates, [5]);
});

test("checkRevnOrder of no entries is vacuously increasing", () => {
    const result = checkRevnOrder([]);
    assert.equal(result.strictlyIncreasing, true);
    assert.equal(result.count, 0);
});

test("checkPresence finds all expected names", () => {
    const names = Array.from({ length: 200 }, (_, i) => nameFor(i));
    const result = checkPresence(names, 200);
    assert.equal(result.present, 200);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.duplicated, []);
    assert.deepEqual(result.unexpected, []);
});

test("checkPresence lists missing and duplicated names", () => {
    const names = [nameFor(0), nameFor(2), nameFor(2), "other-shape"];
    const result = checkPresence(names, 3);
    assert.equal(result.present, 2);
    assert.deepEqual(result.missing, [nameFor(1)]);
    assert.deepEqual(result.duplicated, [nameFor(2)]);
    assert.deepEqual(result.unexpected, ["other-shape"]);
});

test("checkPresence reports a name past the expected count as unexpected", () => {
    const result = checkPresence([nameFor(0), nameFor(5)], 2);
    assert.equal(result.present, 1);
    assert.deepEqual(result.unexpected, [nameFor(5)]);
});

test("planSequence alternates labels and names each write", () => {
    const plan = planSequence(5, ["A", "B"]);
    assert.deepEqual(
        plan.map((p) => p.label),
        ["A", "B", "A", "B", "A"]
    );
    assert.deepEqual(plan[3], { seq: 3, label: "B", name: "xa-seq-0003" });
});

test("planSequence with one label sends everything to it", () => {
    const plan = planSequence(3, ["A"]);
    assert.ok(plan.every((p) => p.label === "A"));
    assert.equal(plan.length, 3);
});

test("summarizeLane counts successes, busy and other errors, and uses only successes for latency", () => {
    const entries = [
        { label: "A", ok: true, busy: false, durationMs: 10 },
        { label: "A", ok: true, busy: false, durationMs: 30 },
        { label: "A", ok: true, busy: false, durationMs: 20 },
        { label: "A", ok: false, busy: true, error: "mcp-file-busy", durationMs: 999 },
        { label: "A", ok: false, busy: false, error: "boom", durationMs: 5 },
        { label: "A", ok: false, busy: false, error: "boom", durationMs: 5 },
    ];
    const lane = summarizeLane(entries);
    assert.equal(lane.label, "A");
    assert.equal(lane.total, 6);
    assert.equal(lane.ok, 3);
    assert.equal(lane.busy, 1);
    assert.equal(lane.other, 2);
    assert.deepEqual(lane.otherErrors, [{ text: "boom", count: 2 }]);
    assert.equal(lane.p50, 20);
    assert.equal(lane.p95, 30);
});

test("summarizeLane of a lane with no successes gives null latency", () => {
    const lane = summarizeLane([{ label: "B", ok: false, busy: true, durationMs: 1 }]);
    assert.equal(lane.p50, null);
    assert.equal(lane.p95, null);
    assert.equal(lane.busy, 1);
});

test("createPacer spaces sends by the rate across callers", async () => {
    let clock = 1000;
    const waits = [];
    const pace = createPacer(
        10,
        () => clock,
        async (ms) => {
            waits.push(ms);
            clock += ms;
        }
    );
    await pace(); // first slot is now, no wait
    await pace(); // 100 ms later
    await pace();
    assert.deepEqual(waits, [100, 100]);
});

test("createPacer does not sleep when the caller is already late", async () => {
    let clock = 0;
    const waits = [];
    const pace = createPacer(
        10,
        () => clock,
        async (ms) => {
            waits.push(ms);
        }
    );
    await pace();
    clock = 500; // caller arrives late; the next slot is 100 ms after the first, already past
    await pace();
    assert.deepEqual(waits, []);
});

test("parseArgs applies the defaults and reads the options", () => {
    const opts = parseArgs([
        "--url-a",
        "http://a/mcp",
        "--url-b",
        "http://b/mcp",
        "--token-file",
        "t.txt",
        "--vars",
        "v.json",
    ]);
    assert.equal(opts.writes, 200);
    assert.equal(opts.perSecond, 10);
    assert.equal(opts.lanes, 2);
    assert.equal(opts.dryRun, false);
});

test("parseArgs rejects a missing required option", () => {
    assert.throws(() => parseArgs(["--url-a", "http://a/mcp"]), /--url-b is required/);
});

test("parseArgs rejects bad numbers and unknown flags", () => {
    const base = ["--url-a", "x", "--url-b", "y", "--token-file", "t", "--vars", "v"];
    assert.throws(() => parseArgs([...base, "--writes", "0"]), /--writes/);
    assert.throws(() => parseArgs([...base, "--lanes", "3"]), /--lanes/);
    assert.throws(() => parseArgs([...base, "--per-second", "-1"]), /--per-second/);
    assert.throws(() => parseArgs([...base, "--bogus"]), /unknown argument/);
});

test("parseArgs accepts help without the required options", () => {
    assert.equal(parseArgs(["--help"]).help, true);
});
