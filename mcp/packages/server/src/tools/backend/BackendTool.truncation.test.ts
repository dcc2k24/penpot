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

test("a response under the cap is returned exactly as pretty-printed JSON", () => {
    const value = { id: "abc", items: [1, 2, 3], nested: { ok: true } };
    assert.equal(BackendTool.formatJson(value, CAP), JSON.stringify(value, null, 2));
    assert.equal(BackendTool.formatJson({ a: 1 }, CAP), '{\n  "a": 1\n}');
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

test("a response too large even with every array emptied gives valid JSON with a null partial", () => {
    const text = BackendTool.formatJson({ text: "x".repeat(5_000) }, 1_000);
    const envelope = parseEnvelope(text);
    assert.equal(envelope.truncated, true);
    assert.equal(envelope.partial, null);
    assert.match(envelope.note, /too large to show/);
});

test("the default cap keeps a response under 1 MB unchanged", () => {
    const value = { shapes: Array.from({ length: 10 }, (_, index) => index) };
    assert.equal(BackendTool.formatJson(value), JSON.stringify(value, null, 2));
});
