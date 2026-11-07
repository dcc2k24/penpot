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
