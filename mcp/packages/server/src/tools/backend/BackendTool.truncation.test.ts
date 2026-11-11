import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendTool } from "./BackendTool";

/** Cap used by the tests, small enough that the sample responses need trimming. */
const CAP = 2_000;

interface Truncated {
    truncated: boolean;
    note: string;
    partial: unknown;
}

function parseEnvelope(text: string): Truncated {
    return JSON.parse(text) as Truncated;
}

test("a large array response is cut to valid JSON that says so", () => {
    const value = {
        shapes: Array.from({ length: 4000 }, (_, index) => ({ id: index, name: `shape ${index}` })),
    };
    const text = BackendTool.formatJson(value, CAP);
    assert.ok(Buffer.byteLength(text, "utf8") <= CAP);
    const envelope = parseEnvelope(text);
    assert.equal(envelope.truncated, true);
    const partial = envelope.partial as { shapes: { id: number; name: string }[] };
    assert.ok(partial.shapes.length > 0);
    assert.ok(partial.shapes.length < 4000);
    assert.deepEqual(partial.shapes, value.shapes.slice(0, partial.shapes.length));
});

test("the note names the trimmed array by its JSON path and counts the items", () => {
    const value = { shapes: Array.from({ length: 4000 }, (_, index) => ({ id: index })) };
    const envelope = parseEnvelope(BackendTool.formatJson(value, CAP));
    const partial = envelope.partial as { shapes: unknown[] };
    assert.match(envelope.note, /\$\.shapes: kept \d+ of 4000 items/);
    assert.match(envelope.note, new RegExp(`kept ${partial.shapes.length} of 4000 items`));
});

test("a response under the cap is returned as compact JSON", () => {
    const value = { id: "abc", items: [1, 2, 3], nested: { ok: true } };
    assert.equal(BackendTool.formatJson(value, CAP), JSON.stringify(value));
    assert.equal(BackendTool.formatJson({ a: 1 }, CAP), '{"a":1}');
    assert.equal(BackendTool.formatJson(undefined, CAP), "null");
});

test("nested arrays are trimmed and each one is noted by its path", () => {
    const value = {
        groups: Array.from({ length: 50 }, (_, group) => ({
            id: group,
            items: Array.from({ length: 50 }, (_, item) => item),
        })),
    };
    const text = BackendTool.formatJson(value, 8_000);
    assert.ok(Buffer.byteLength(text, "utf8") <= 8_000);
    const envelope = parseEnvelope(text);
    assert.equal(envelope.truncated, true);
    const partial = envelope.partial as { groups: { id: number; items: number[] }[] };
    assert.ok(partial.groups.length < 50);
    for (const group of partial.groups) {
        assert.ok(group.items.length < 50);
    }
    assert.match(envelope.note, /\$\.groups: kept \d+ of 50 items/);
    assert.match(envelope.note, /\$\.groups\[0\]\.items: kept \d+ of 50 items/);
});

test("a response whose long strings must be cut keeps the arrays and cuts the strings", () => {
    const value = { text: "x".repeat(5_000) };
    const text = BackendTool.formatJson(value, 1_000);
    assert.ok(Buffer.byteLength(text, "utf8") <= 1_000);
    const envelope = parseEnvelope(text);
    assert.equal(envelope.truncated, true);
    const partial = envelope.partial as { text: string };
    assert.equal(partial.text.length, 203);
    assert.match(envelope.note, /1 long string cut to 200 characters/);
});

test("a response too large even with every array emptied gives valid JSON with a null partial", () => {
    const value = { a: "x".repeat(300), b: "y".repeat(300), c: "z".repeat(300) };
    const text = BackendTool.formatJson(value, 100);
    const envelope = parseEnvelope(text);
    assert.equal(envelope.truncated, true);
    assert.equal(envelope.partial, null);
    assert.match(envelope.note, /too large to show/);
});

test("a truncated answer drops nextCursor and tells the agent to repeat the call with a smaller limit", () => {
    const value = {
        nodes: Array.from({ length: 4000 }, (_, index) => ({ id: index })),
        nextCursor: "cursor-that-skips-the-cut-nodes",
    };
    const envelope = parseEnvelope(BackendTool.formatJson(value, CAP));
    const partial = envelope.partial as Record<string, unknown>;
    assert.equal("nextCursor" in partial, false);
    assert.match(envelope.note, /nextCursor was removed/);
    assert.match(envelope.note, /Repeat the call with a smaller limit/);
    assert.match(envelope.note, /truncated: the response exceeded/);
});

test("an answer under the cap keeps nextCursor", () => {
    const value = { nodes: [{ id: 1 }], nextCursor: "next" };
    assert.deepEqual(JSON.parse(BackendTool.formatJson(value, CAP)), value);
});

test("the response cap defaults to 100 kB and reads the kilobyte setting", () => {
    assert.equal(BackendTool.readMaxResponseBytes({}), 100_000);
    assert.equal(BackendTool.readMaxResponseBytes({ PENPOT_MCP_MAX_TOOL_RESPONSE_KB: "" }), 100_000);
    assert.equal(BackendTool.readMaxResponseBytes({ PENPOT_MCP_MAX_TOOL_RESPONSE_KB: "250" }), 250_000);
});

test("a response cap setting that is not a whole number of kilobytes fails with its name", () => {
    for (const raw of ["0", "-5", "1.5", "lots", "20000"]) {
        assert.throws(
            () => BackendTool.readMaxResponseBytes({ PENPOT_MCP_MAX_TOOL_RESPONSE_KB: raw }),
            /PENPOT_MCP_MAX_TOOL_RESPONSE_KB must be a whole number of kilobytes/
        );
    }
});

test("the default cap keeps a response under 100 kB unchanged", () => {
    const value = { shapes: Array.from({ length: 10 }, (_, index) => index) };
    assert.equal(BackendTool.formatJson(value), JSON.stringify(value));
});

const PAGE_CAP = 3_000;

function pagedReply(extra: Record<string, unknown>, count = 200, size = 80) {
    return {
        revn: 3,
        total: count,
        items: Array.from({ length: count }, (_, n) => ({ id: n, name: "x".repeat(size) })),
        truncated: false,
        ...extra,
    };
}

test("a paged reply above the cap keeps whole items and sets nextOffset from the offset of the call", () => {
    const value = pagedReply({ nextOffset: 250 });
    const body = JSON.parse(BackendTool.formatPagedJson(value, "items", 50, "fewer rules", PAGE_CAP)) as {
        items: unknown[];
        nextOffset: number;
        truncated: boolean;
        partial?: unknown;
    };
    assert.equal(body.partial, undefined);
    assert.equal(body.truncated, true);
    assert.ok(body.items.length > 0 && body.items.length < 200);
    assert.equal(body.nextOffset, 50 + body.items.length);
    assert.deepEqual(body.items, value.items.slice(0, body.items.length));
});

test("a timed-out paged reply above the cap is cut at whole items with no nextOffset, and the note says to narrow", () => {
    const value = pagedReply({ timedOut: true, truncated: true });
    const text = BackendTool.formatPagedJson(value, "items", 0, "fewer rules", PAGE_CAP);
    assert.ok(Buffer.byteLength(text, "utf8") <= PAGE_CAP);
    const body = JSON.parse(text) as { items: unknown[]; note: string; timedOut: boolean; nextOffset?: number };
    assert.equal(body.timedOut, true);
    assert.equal(body.nextOffset, undefined);
    assert.ok(body.items.length > 0 && body.items.length < 200);
    assert.match(body.note, /ran out of time/);
    assert.match(body.note, /cannot be continued/);
    assert.match(body.note, /narrower call: fewer rules/);
});

test("a single item above the cap gets the generic cut, which drops nextOffset", () => {
    const value = pagedReply({ nextOffset: 1 }, 1, 6_000);
    const text = BackendTool.formatPagedJson(value, "items", 0, "fewer rules", PAGE_CAP);
    assert.ok(Buffer.byteLength(text, "utf8") <= PAGE_CAP);
    const envelope = JSON.parse(text) as { truncated: boolean; note: string; partial: Record<string, unknown> };
    assert.equal(envelope.truncated, true);
    assert.equal("nextOffset" in envelope.partial, false);
    assert.match(envelope.note, /nextOffset was removed/);
});

test("the generic cut drops nextOffset beside nextCursor and names both", () => {
    const value = { rows: Array.from({ length: 4000 }, (_, n) => ({ n })), nextCursor: "c", nextOffset: 9 };
    const envelope = parseEnvelope(BackendTool.formatJson(value, CAP));
    assert.equal("nextCursor" in (envelope.partial as object), false);
    assert.equal("nextOffset" in (envelope.partial as object), false);
    assert.match(envelope.note, /nextCursor was removed/);
    assert.match(envelope.note, /nextOffset was removed/);
});

test("a timed-out paged reply under the cap carries the note and no nextOffset", () => {
    const value = pagedReply({ timedOut: true, truncated: true }, 3);
    const text = BackendTool.formatPagedJson(value, "items", 0, "fewer rules", PAGE_CAP);
    const body = JSON.parse(text) as { items: unknown[]; note: string; nextOffset?: number; timedOut: boolean };
    assert.equal(body.items.length, 3);
    assert.equal(body.timedOut, true);
    assert.equal(body.nextOffset, undefined);
    assert.match(body.note, /ran out of time/);
    assert.match(body.note, /totals are not complete/);
    assert.match(body.note, /cannot be continued with offset/);
    assert.match(body.note, /narrower call: fewer rules\./);
});

test("a note of the backend stays, and the time-out note follows it", () => {
    const value = pagedReply({ timedOut: true, truncated: true, note: "from the backend" }, 3);
    const body = JSON.parse(BackendTool.formatPagedJson(value, "items", 0, "fewer rules", PAGE_CAP)) as {
        note: string;
    };
    assert.match(body.note, /^from the backend The call ran out of time/);
});

test("a timed-out reply that is also cut by bytes has one note that says both", () => {
    const value = pagedReply({ timedOut: true, truncated: true, note: "from the backend" });
    const body = JSON.parse(BackendTool.formatPagedJson(value, "items", 0, "fewer rules", PAGE_CAP)) as {
        note: string;
        nextOffset?: number;
    };
    assert.equal(body.nextOffset, undefined);
    assert.match(body.note, /^from the backend Reply cut to fit 3000 bytes: kept \d+ of the 200 items\./);
    assert.match(body.note, /ran out of time/);
});

test("a normal paged reply under the cap is unchanged", () => {
    const value = pagedReply({ nextOffset: 3 }, 3);
    assert.equal(BackendTool.formatPagedJson(value, "items", 0, "fewer rules", PAGE_CAP), JSON.stringify(value));
});
